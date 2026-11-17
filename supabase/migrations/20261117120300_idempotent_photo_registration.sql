-- Photo registration that can be retried safely.
--
-- The website uploads a photo to Storage, then records it with
-- admin_add_product_image. If that call's answer was lost (a network error
-- after the database had committed), the website deleted the uploaded file,
-- leaving a photo row that points at nothing; and a retry was refused, since
-- the first call had already moved the product's version on.
--
-- Each registration is now kept, keyed by its image id (a UUID the website
-- makes for each upload), in private.photo_registrations: the request as it
-- was first made (product, expected version, storage path, width, height,
-- alt text) and the product version it produced. The table is written only
-- here and never changed, so it still holds the original request after the
-- photo's alt text is edited, or after the photo is removed again.
--
--   * The product row is locked FIRST, before looking for the registration,
--     so a retry made while the first call is still running waits for it to
--     commit or roll back (a lookup without the lock could miss a commit in
--     flight).
--   * A retry is the same request again: every recorded field must be equal.
--     It returns the version THAT registration produced, never the product's
--     current one. If someone else has saved since, the editor is therefore
--     still behind, and its next save is refused as a conflict (PT409) instead
--     of overwriting their change with the editor's stale fields.
--   * The same image id with any other request data is refused (PT409,
--     image_conflict). So is an image id that exists as a photo but has no
--     registration (recorded before this migration): its original request is
--     unknown, so the admin reloads.
--   * A new image id still needs the current version (PT409, version_conflict).
--
-- Only a refusal from the database proves nothing was recorded; the website
-- deletes the uploaded file only then (lib/admin/photo-registration.ts).

create table private.photo_registrations (
  image_id uuid primary key,
  product_id uuid not null references public.products (id) on delete cascade,
  expected_version integer not null,
  storage_path text not null,
  width integer not null,
  height integer not null,
  alt text not null,
  registered_version integer not null,
  registered_by uuid,
  created_at timestamptz not null default now()
);

comment on table private.photo_registrations is
  'One row per photo registration (admin_add_product_image): the original request and the version it produced, so a retry gets the same answer.';

revoke all on table private.photo_registrations from public, anon, authenticated;

create or replace function public.admin_add_product_image(
  p_product_id uuid,
  p_expected_version integer,
  p_image_id uuid,
  p_storage_path text,
  p_width integer,
  p_height integer,
  p_alt text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_product public.products;
  registration private.photo_registrations;
  new_version integer;
begin
  perform public.admin_require_catalogue_admin();

  -- The lock first: a registration of this image still in progress holds it.
  select * into current_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found.' using errcode = 'PT404';
  end if;

  select * into registration from private.photo_registrations r where r.image_id = p_image_id;
  if found then
    if (registration.product_id, registration.expected_version, registration.storage_path,
        registration.width, registration.height, registration.alt)
       is not distinct from
       (p_product_id, p_expected_version, p_storage_path, p_width, p_height, p_alt) then
      -- A retry: the answer the first call gave.
      return registration.registered_version;
    end if;
    raise exception 'This photo id was already used for a different request.'
      using errcode = 'PT409', hint = 'image_conflict';
  end if;
  if exists (select 1 from public.product_images i where i.id = p_image_id) then
    raise exception 'This photo was recorded earlier. Reload the page.'
      using errcode = 'PT409', hint = 'image_conflict';
  end if;

  if p_expected_version is null or current_product.version <> p_expected_version then
    raise exception 'This product was changed somewhere else since you opened it.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;

  if (select count(*) from public.product_images where product_id = p_product_id) >= 12 then
    raise exception 'A product can have at most 12 photos.' using errcode = 'PT400', hint = 'too_many_photos';
  end if;

  insert into public.product_images (id, product_id, storage_path, alt, width, height, sort_order)
  values (
    p_image_id, p_product_id, p_storage_path, p_alt, p_width, p_height,
    coalesce((select max(sort_order) + 1 from public.product_images where product_id = p_product_id), 0)
  );

  -- Count the new photo as a change to the product (bumps its version).
  update public.products set name = name where id = p_product_id
  returning version into new_version;

  insert into private.photo_registrations
    (image_id, product_id, expected_version, storage_path, width, height, alt, registered_version, registered_by)
  values
    (p_image_id, p_product_id, p_expected_version, p_storage_path, p_width, p_height, p_alt, new_version, (select auth.uid()));

  set constraints all immediate;
  return new_version;
end;
$$;
