"use client";

import Link from "next/link";
import { useActionState, useId, useMemo, useRef, useState, useTransition } from "react";
import {
  changeProductStatus,
  createProduct,
  saveProduct,
  uploadProductPhoto,
  type ProductFormState,
} from "@/app/admin/products/actions";
import {
  EMPTY_PRODUCT,
  LIMITS,
  PHOTO_UPLOAD,
  PRELOVED_CONDITIONS,
  STYLES,
  suggestSlug,
  type FieldErrors,
  type FieldName,
  type ProductFormValues,
  type SizeValue,
} from "@/lib/admin/product-input";
import type { AdminPhoto, EditableProduct, PublicationStatus } from "@/lib/admin/products";
import { CONDITION_LABELS, DEPARTMENTS, DEPARTMENT_ORDER, STYLE_LABELS } from "@/lib/catalog/labels";
import { PublicationBadge } from "./publication-badge";
import { useUnsavedChangesWarning } from "./use-unsaved-changes";

const INITIAL_STATE: ProductFormState = { status: "idle", message: null, errors: {} };

const INPUT =
  "w-full rounded-md border border-line bg-white px-3 text-sm focus:border-forest focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-forest aria-[invalid=true]:border-danger";
const LABEL = "mb-1.5 block text-sm font-semibold";
const HINT = "mt-1 text-xs text-muted";
const ERROR = "mt-1 text-sm font-medium text-danger";

const FIELD_LABELS: Record<FieldName, string> = {
  name: "Product name",
  brand: "Brand",
  colour: "Colour",
  department: "Department",
  styles: "Styles",
  itemStatus: "Type",
  condition: "Condition",
  conditionNotes: "Condition notes",
  description: "Description",
  price: "Price",
  itemCode: "Item code",
  slug: "Web address name",
  sizes: "Sizes and stock",
  photos: "Photos",
};

type Saved = { values: ProductFormValues; photos: AdminPhoto[] };

const snapshot = (saved: Saved) => JSON.stringify(saved);

export function ProductEditor({ product, created = false }: { product?: EditableProduct; created?: boolean }) {
  const isNew = !product;
  const id = useId();
  const fieldId = (name: string) => `${id}-${name}`;

  const [values, setValues] = useState<ProductFormValues>(product?.values ?? EMPTY_PRODUCT);
  const [photos, setPhotos] = useState<AdminPhoto[]>(product?.photos ?? []);
  const [version, setVersion] = useState(product?.version ?? 0);
  const [status, setStatus] = useState<PublicationStatus>(product?.status ?? "draft");
  const [listedAt, setListedAt] = useState(product?.listedAt ?? null);
  const [saved, setSaved] = useState<Saved>({ values: product?.values ?? EMPTY_PRODUCT, photos: product?.photos ?? [] });

  const applyProduct = (next: EditableProduct) => {
    setValues(next.values);
    setPhotos(next.photos);
    setVersion(next.version);
    setStatus(next.status);
    setListedAt(next.listedAt);
    setSaved({ values: next.values, photos: next.photos });
  };

  const [state, formAction, saving] = useActionState(async (previous: ProductFormState, formData: FormData) => {
    const result = await (isNew ? createProduct : saveProduct)(previous, formData);
    if (result.status === "saved" && result.product) applyProduct(result.product);
    return result;
  }, INITIAL_STATE);

  const dirty = useMemo(() => snapshot({ values, photos }) !== snapshot(saved), [values, photos, saved]);
  useUnsavedChangesWarning(dirty);

  const errors: FieldErrors = state.errors;
  const locked = listedAt !== null;
  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const describedBy = (name: FieldName, hint = false) =>
    [hint ? `${fieldId(name)}-hint` : null, errors[name] ? `${fieldId(name)}-error` : null].filter(Boolean).join(" ") || undefined;
  const errorText = (name: FieldName) =>
    errors[name] ? (
      <p id={`${fieldId(name)}-error`} className={ERROR}>
        {errors[name]}
      </p>
    ) : null;

  const errorEntries = Object.entries(errors) as [FieldName, string][];

  return (
    <div className="pb-28">
      {created ? (
        <p role="status" className="mb-6 rounded-md bg-forest-soft px-4 py-3 text-sm">
          Draft created. Add photos below, then publish it when it&apos;s ready.
        </p>
      ) : null}

      {!isNew ? (
        <StatusPanel
          productId={product.id}
          slug={saved.values.slug}
          status={status}
          version={version}
          dirty={dirty}
          onChanged={applyProduct}
        />
      ) : null}

      <form action={formAction} noValidate aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className="sr-only">
          Product details
        </h2>
        {!isNew ? (
          <>
            <input type="hidden" name="productId" value={product.id} />
            <input type="hidden" name="version" value={version} />
            <input
              type="hidden"
              name="photos"
              value={JSON.stringify(photos.map((p) => ({ id: p.id, alt: p.alt, showsDefect: p.showsDefect })))}
            />
          </>
        ) : null}
        <input type="hidden" name="sizes" value={JSON.stringify(values.sizes.map(({ size, stock }) => ({ size, stock })))} />

        {errorEntries.length > 0 ? (
          <div role="alert" className="mb-6 rounded-md border border-danger/40 bg-danger/5 px-4 py-3 text-sm">
            <p className="font-semibold text-danger">{state.message ?? "Check the highlighted fields."}</p>
            <ul className="mt-1 list-disc pl-5">
              {errorEntries.map(([name, message]) => (
                <li key={name}>
                  <a href={`#${fieldId(name)}`} className="link-underline">
                    {FIELD_LABELS[name]}
                  </a>
                  : {message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <Section title="What it is">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <label htmlFor={fieldId("name")} className={LABEL}>
                Product name
              </label>
              <input
                id={fieldId("name")}
                name="name"
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
                maxLength={LIMITS.name}
                required
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={describedBy("name", true)}
                className={`${INPUT} h-11`}
              />
              <p id={`${fieldId("name")}-hint`} className={HINT}>
                Model and colour, as shoppers see it, e.g. “Air Max Sneakers — White/Orange”.
              </p>
              {errorText("name")}
            </div>
            <div>
              <label htmlFor={fieldId("brand")} className={LABEL}>
                Brand
              </label>
              <input
                id={fieldId("brand")}
                name="brand"
                value={values.brand}
                onChange={(e) => set("brand", e.target.value)}
                maxLength={LIMITS.brand}
                required
                aria-invalid={errors.brand ? true : undefined}
                aria-describedby={describedBy("brand", true)}
                className={`${INPUT} h-11`}
              />
              <p id={`${fieldId("brand")}-hint`} className={HINT}>
                Use “Unbranded” if there isn&apos;t one.
              </p>
              {errorText("brand")}
            </div>
            <div>
              <label htmlFor={fieldId("colour")} className={LABEL}>
                Colour
              </label>
              <input
                id={fieldId("colour")}
                name="colour"
                value={values.colour}
                onChange={(e) => set("colour", e.target.value)}
                maxLength={LIMITS.colour}
                required
                aria-invalid={errors.colour ? true : undefined}
                aria-describedby={describedBy("colour")}
                className={`${INPUT} h-11`}
              />
              {errorText("colour")}
            </div>
            <div>
              <label htmlFor={fieldId("department")} className={LABEL}>
                Department
              </label>
              <select
                id={fieldId("department")}
                name="department"
                value={values.department}
                onChange={(e) => set("department", e.target.value as ProductFormValues["department"])}
                aria-invalid={errors.department ? true : undefined}
                aria-describedby={describedBy("department")}
                className={`${INPUT} h-11`}
              >
                {DEPARTMENT_ORDER.map((d) => (
                  <option key={d} value={d}>
                    {DEPARTMENTS[d].label}
                  </option>
                ))}
              </select>
              {errorText("department")}
            </div>
            <fieldset aria-describedby={describedBy("itemStatus")}>
              <legend className={LABEL}>Type</legend>
              <div className="flex flex-wrap gap-4 pt-2 text-sm">
                {(["preloved", "new"] as const).map((type) => (
                  <label key={type} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="itemStatus"
                      value={type}
                      checked={values.itemStatus === type}
                      onChange={() =>
                        setValues((current) => ({
                          ...current,
                          itemStatus: type,
                          condition: type === "new" ? "new" : current.condition === "new" ? "excellent" : current.condition,
                          sizes:
                            type === "preloved"
                              ? [{ ...(current.sizes[0] ?? { size: "", stock: "1" }), stock: current.sizes[0]?.stock === "0" ? "0" : "1" }]
                              : current.sizes,
                        }))
                      }
                      className="size-4 accent-forest"
                    />
                    {type === "preloved" ? "Pre-loved (one pair)" : "New (several sizes)"}
                  </label>
                ))}
              </div>
              {errorText("itemStatus")}
            </fieldset>
            <fieldset id={fieldId("styles")} className="md:col-span-2" aria-describedby={describedBy("styles", true)}>
              <legend className={LABEL}>Styles</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                {STYLES.map((style) => (
                  <label key={style} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="styles"
                      value={style}
                      checked={values.styles.includes(style)}
                      onChange={(e) =>
                        set("styles", e.target.checked ? [...values.styles, style] : values.styles.filter((s) => s !== style))
                      }
                      className="size-4 accent-forest"
                    />
                    {STYLE_LABELS[style]}
                  </label>
                ))}
              </div>
              <p id={`${fieldId("styles")}-hint`} className={HINT}>
                At least one is needed to publish. Shoppers filter by these.
              </p>
              {errorText("styles")}
            </fieldset>
          </div>
        </Section>

        <Section title="Condition and description">
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label htmlFor={fieldId("condition")} className={LABEL}>
                Condition
              </label>
              {values.itemStatus === "new" ? (
                <>
                  <input type="hidden" name="condition" value="new" />
                  <p id={fieldId("condition")} className="flex h-11 items-center text-sm text-muted">
                    New (always, for new shoes)
                  </p>
                </>
              ) : (
                <select
                  id={fieldId("condition")}
                  name="condition"
                  value={values.condition}
                  onChange={(e) => set("condition", e.target.value as ProductFormValues["condition"])}
                  aria-invalid={errors.condition ? true : undefined}
                  aria-describedby={describedBy("condition")}
                  className={`${INPUT} h-11`}
                >
                  {PRELOVED_CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {CONDITION_LABELS[c]}
                    </option>
                  ))}
                </select>
              )}
              {errorText("condition")}
            </div>
            <div className="md:col-span-2">
              <label htmlFor={fieldId("conditionNotes")} className={LABEL}>
                Condition notes <span className="font-normal text-muted">(optional)</span>
              </label>
              <textarea
                id={fieldId("conditionNotes")}
                name="conditionNotes"
                value={values.conditionNotes}
                onChange={(e) => set("conditionNotes", e.target.value)}
                rows={3}
                aria-invalid={errors.conditionNotes ? true : undefined}
                aria-describedby={describedBy("conditionNotes", true)}
                className={`${INPUT} py-2`}
              />
              <p id={`${fieldId("conditionNotes")}-hint`} className={HINT}>
                One note per line, e.g. “Light creasing on the toe”. Up to {LIMITS.conditionNotes} notes.
              </p>
              {errorText("conditionNotes")}
            </div>
            <div className="md:col-span-2">
              <label htmlFor={fieldId("description")} className={LABEL}>
                Description
              </label>
              <textarea
                id={fieldId("description")}
                name="description"
                value={values.description}
                onChange={(e) => set("description", e.target.value)}
                rows={4}
                maxLength={LIMITS.description}
                aria-invalid={errors.description ? true : undefined}
                aria-describedby={describedBy("description", true)}
                className={`${INPUT} py-2`}
              />
              <p id={`${fieldId("description")}-hint`} className={HINT}>
                Needed to publish.
              </p>
              {errorText("description")}
            </div>
          </div>
        </Section>

        <Section title="Price, codes and sizes">
          <div className="grid gap-5 md:grid-cols-3">
            <div>
              <label htmlFor={fieldId("price")} className={LABEL}>
                Price (rupees)
              </label>
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="text-sm text-muted">
                  Rs.
                </span>
                <input
                  id={fieldId("price")}
                  name="price"
                  inputMode="decimal"
                  autoComplete="off"
                  value={values.price}
                  onChange={(e) => set("price", e.target.value)}
                  required
                  aria-invalid={errors.price ? true : undefined}
                  aria-describedby={describedBy("price", true)}
                  className={`${INPUT} h-11`}
                />
              </div>
              <p id={`${fieldId("price")}-hint`} className={HINT}>
                e.g. 8500 or 8,500.50. Must be above zero to publish.
              </p>
              {errorText("price")}
            </div>
            <div>
              <label htmlFor={fieldId("itemCode")} className={LABEL}>
                Item code
              </label>
              <input
                id={fieldId("itemCode")}
                name="itemCode"
                value={values.itemCode}
                onChange={(e) => set("itemCode", e.target.value.toUpperCase())}
                readOnly={locked}
                maxLength={LIMITS.itemCode}
                autoComplete="off"
                spellCheck={false}
                required
                aria-invalid={errors.itemCode ? true : undefined}
                aria-describedby={describedBy("itemCode", true)}
                className={`${INPUT} h-11 font-mono uppercase read-only:bg-cream`}
              />
              <p id={`${fieldId("itemCode")}-hint`} className={HINT}>
                {locked
                  ? "Fixed: this product has been published."
                  : "Shown on the product page, e.g. PL-M-1001. Fixed once published."}
              </p>
              {errorText("itemCode")}
            </div>
            <div>
              <label htmlFor={fieldId("slug")} className={LABEL}>
                Web address name
              </label>
              <input
                id={fieldId("slug")}
                name="slug"
                value={values.slug}
                onChange={(e) => set("slug", e.target.value.toLowerCase())}
                maxLength={LIMITS.slug}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.slug ? true : undefined}
                aria-describedby={describedBy("slug", true)}
                className={`${INPUT} h-11 font-mono`}
              />
              <p id={`${fieldId("slug")}-hint`} className={HINT}>
                /products/{values.slug || suggestSlug(values) || "…"}.{" "}
                {values.slug ? (
                  locked ? "Changing it breaks links people already have." : null
                ) : (
                  "Left empty, it’s made from the brand and name."
                )}{" "}
                <button
                  type="button"
                  onClick={() => set("slug", suggestSlug(values))}
                  className="font-semibold text-forest underline"
                >
                  Suggest one
                </button>
              </p>
              {errorText("slug")}
            </div>
          </div>

          <SizesEditor
            id={fieldId("sizes")}
            itemStatus={values.itemStatus}
            itemCode={values.itemCode}
            sizes={values.sizes}
            lockedSkus={locked ? new Set(saved.values.sizes.map((s) => s.sku).filter((s): s is string => !!s)) : new Set()}
            error={errors.sizes}
            onChange={(sizes) => set("sizes", sizes)}
          />
        </Section>

        {!isNew ? (
          <PhotosEditor
            id={fieldId("photos")}
            productId={product.id}
            version={version}
            photos={photos}
            error={errors.photos}
            onChange={setPhotos}
            onUploaded={(photo, newVersion) => {
              setVersion(newVersion);
              setPhotos((current) => [...current, photo]);
              setSaved((current) => ({ ...current, photos: [...current.photos, photo] }));
            }}
          />
        ) : (
          <Section title="Photos">
            <p className="text-sm text-muted">Create the draft first, then add photos on the next screen.</p>
          </Section>
        )}

        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 backdrop-blur">
          <div className="container-page flex flex-wrap items-center justify-between gap-3 py-3">
            <div aria-live="polite" className="min-w-0 text-sm">
              {state.status === "conflict" ? (
                <span role="alert" className="font-medium text-danger">
                  {state.message}{" "}
                  <a href="" className="font-semibold underline">
                    Reload
                  </a>
                </span>
              ) : state.status === "error" && errorEntries.length === 0 ? (
                <span role="alert" className="font-medium text-danger">
                  {state.message}
                </span>
              ) : saving ? (
                <span className="text-muted">Saving…</span>
              ) : dirty ? (
                <span className="font-medium">You have unsaved changes.</span>
              ) : state.status === "saved" ? (
                <span className="text-forest">{state.message}</span>
              ) : (
                <span className="text-muted">{isNew ? "New products are saved as drafts." : "All changes saved."}</span>
              )}
            </div>
            <div className="flex gap-2">
              <Link href="/admin/products" className="btn btn-outline">
                Back to products
              </Link>
              <button type="submit" disabled={saving || (!isNew && !dirty)} className="btn btn-forest disabled:opacity-60">
                {saving ? "Saving…" : isNew ? "Create draft" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 rounded-lg border border-line p-5 md:p-6">
      <h3 className="mb-4 text-base font-bold">{title}</h3>
      {children}
    </section>
  );
}

function SizesEditor({
  id,
  itemStatus,
  itemCode,
  sizes,
  lockedSkus,
  error,
  onChange,
}: {
  id: string;
  itemStatus: ProductFormValues["itemStatus"];
  itemCode: string;
  sizes: SizeValue[];
  lockedSkus: Set<string>;
  error?: string;
  onChange: (sizes: SizeValue[]) => void;
}) {
  const update = (index: number, change: Partial<SizeValue>) =>
    onChange(sizes.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const preloved = itemStatus === "preloved";
  const rows = preloved ? sizes.slice(0, 1) : sizes;

  return (
    <fieldset id={id} className="mt-6" aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}>
      <legend className={LABEL}>{preloved ? "Size and availability" : "Sizes and stock"}</legend>
      <p id={`${id}-hint`} className={HINT}>
        {preloved
          ? "A pre-loved listing is one physical pair: one EU size, 1 if it’s for sale or 0 once sold."
          : "One row per EU size, with how many pairs you have (0 shows it as sold out)."}{" "}
        {lockedSkus.size > 0 ? "Published sizes can’t be removed or changed; set their stock to 0 instead." : null}
      </p>
      <div className="mt-3 space-y-2">
        {rows.map((row, index) => {
          const fixed = !!row.sku && lockedSkus.has(row.sku);
          const sku = row.sku ?? (itemCode && row.size ? `${itemCode}-${Number(row.size)}` : "");
          return (
            <div key={row.sku ?? `row-${index}`} className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor={`${id}-size-${index}`} className="mb-1 block text-xs font-semibold">
                  EU size
                </label>
                <input
                  id={`${id}-size-${index}`}
                  inputMode="decimal"
                  value={row.size}
                  onChange={(e) => update(index, { size: e.target.value.trim() })}
                  readOnly={fixed}
                  aria-invalid={error ? true : undefined}
                  className={`${INPUT} h-10 w-24 read-only:bg-cream`}
                />
              </div>
              <div>
                <label htmlFor={`${id}-stock-${index}`} className="mb-1 block text-xs font-semibold">
                  {preloved ? "Availability" : "Stock"}
                </label>
                {preloved ? (
                  <select
                    id={`${id}-stock-${index}`}
                    value={row.stock === "0" ? "0" : "1"}
                    onChange={(e) => update(index, { stock: e.target.value })}
                    className={`${INPUT} h-10 w-36`}
                  >
                    <option value="1">For sale (1)</option>
                    <option value="0">Sold (0)</option>
                  </select>
                ) : (
                  <input
                    id={`${id}-stock-${index}`}
                    inputMode="numeric"
                    value={row.stock}
                    onChange={(e) => update(index, { stock: e.target.value.trim() })}
                    aria-invalid={error ? true : undefined}
                    className={`${INPUT} h-10 w-24`}
                  />
                )}
              </div>
              <p className="pb-2.5 font-mono text-xs text-muted" title="SKU">
                {sku ? `SKU ${sku}` : null}
                {!row.sku && sku ? " (new)" : null}
              </p>
              {!preloved ? (
                <button
                  type="button"
                  onClick={() => onChange(sizes.filter((_, i) => i !== index))}
                  disabled={fixed}
                  className="mb-1 text-sm font-semibold text-danger underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                  aria-label={`Remove size ${row.size || index + 1}`}
                >
                  Remove
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {!preloved ? (
        <button
          type="button"
          onClick={() => onChange([...sizes, { size: "", stock: "0" }])}
          disabled={sizes.length >= LIMITS.sizes}
          className="btn btn-outline mt-3 h-9 text-sm"
        >
          Add a size
        </button>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className={ERROR}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function PhotosEditor({
  id,
  productId,
  version,
  photos,
  error,
  onChange,
  onUploaded,
}: {
  id: string;
  productId: string;
  version: number;
  photos: AdminPhoto[];
  error?: string;
  onChange: (photos: AdminPhoto[]) => void;
  onUploaded: (photo: AdminPhoto, version: number) => void;
}) {
  const [uploading, startUpload] = useTransition();
  const [uploadMessage, setUploadMessage] = useState<{ error: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const move = (index: number, by: -1 | 1) => {
    const next = [...photos];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange(next);
  };
  const update = (index: number, change: Partial<AdminPhoto>) =>
    onChange(photos.map((p, i) => (i === index ? { ...p, ...change } : p)));

  const upload = (files: FileList | null) => {
    const chosen = [...(files ?? [])];
    if (fileInput.current) fileInput.current.value = "";
    if (chosen.length === 0) return;
    setUploadMessage(null);
    startUpload(async () => {
      // Each upload bumps the product's version; the next one must use it.
      let currentVersion = version;
      let added = 0;
      for (const file of chosen) {
        if (file.size > PHOTO_UPLOAD.maxBytes) {
          setUploadMessage({ error: true, text: `“${file.name}” is over 4 MB. Use a smaller photo.` });
          break;
        }
        const formData = new FormData();
        formData.set("productId", productId);
        formData.set("version", String(currentVersion));
        formData.set("photo", file);
        const result = await uploadProductPhoto(formData);
        if (!result.ok) {
          setUploadMessage({ error: true, text: `“${file.name}”: ${result.error}` });
          break;
        }
        currentVersion = result.version;
        onUploaded(result.photo, result.version);
        added++;
      }
      if (added > 0) {
        setUploadMessage((current) =>
          current ?? { error: false, text: `${added} photo${added === 1 ? "" : "s"} added. Check the descriptions, then save.` },
        );
      }
    });
  };

  return (
    <Section title="Photos">
      <div id={id} tabIndex={-1}>
        <p className={HINT}>
          The first photo is the main one. JPEG, PNG or WebP, up to 4 MB, at least 400 pixels on each side. Photos are
          private until the product is published.
        </p>

        {photos.length > 0 ? (
          <ol className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {photos.map((photo, index) => (
              <li key={photo.id} className="rounded-md border border-line p-3">
                <div className="relative aspect-square overflow-hidden rounded bg-cream">
                  {/* Private previews come from a signed-in route; next/image would cache them in a shared cache. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo.previewSrc} alt="" className="size-full object-cover" />
                  <span className="absolute left-2 top-2 rounded bg-white/90 px-1.5 py-0.5 text-xs font-semibold">
                    {index === 0 ? "Main photo" : `Photo ${index + 1}`}
                  </span>
                </div>
                <label htmlFor={`${id}-alt-${photo.id}`} className="mt-3 mb-1 block text-xs font-semibold">
                  Description for screen readers
                </label>
                <input
                  id={`${id}-alt-${photo.id}`}
                  value={photo.alt}
                  onChange={(e) => update(index, { alt: e.target.value })}
                  maxLength={LIMITS.alt}
                  aria-invalid={error && !photo.alt.trim() ? true : undefined}
                  className={`${INPUT} h-9`}
                />
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={photo.showsDefect}
                    onChange={(e) => update(index, { showsDefect: e.target.checked })}
                    className="size-4 accent-forest"
                  />
                  Shows wear or a flaw
                </label>
                <div className="mt-3 flex flex-wrap gap-2 text-sm">
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className="btn btn-outline h-8 px-2 text-xs disabled:opacity-50" aria-label={`Move photo ${index + 1} earlier`}>
                    Earlier
                  </button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === photos.length - 1} className="btn btn-outline h-8 px-2 text-xs disabled:opacity-50" aria-label={`Move photo ${index + 1} later`}>
                    Later
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(photos.filter((_, i) => i !== index))}
                    className="ml-auto text-xs font-semibold text-danger underline"
                    aria-label={`Remove photo ${index + 1} from the listing`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-4 text-sm">No photos yet. A product needs at least one to be published.</p>
        )}

        <div className="mt-5">
          <label htmlFor={`${id}-upload`} className={LABEL}>
            Add photos
          </label>
          <input
            ref={fileInput}
            id={`${id}-upload`}
            type="file"
            accept={PHOTO_UPLOAD.accept}
            multiple
            disabled={uploading || photos.length >= LIMITS.photos}
            onChange={(e) => upload(e.target.files)}
            className="block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-forest file:px-3 file:py-2 file:font-semibold file:text-white"
          />
          <p aria-live="polite" className="mt-2 text-sm">
            {uploading ? (
              <span className="text-muted">Uploading…</span>
            ) : uploadMessage ? (
              <span className={uploadMessage.error ? "font-medium text-danger" : "text-forest"}>{uploadMessage.text}</span>
            ) : null}
          </p>
          <p className={HINT}>
            Uploaded photos are kept straight away. Removing one takes effect when you save.
          </p>
        </div>
        {error ? <p className={ERROR}>{error}</p> : null}
      </div>
    </Section>
  );
}

function StatusPanel({
  productId,
  slug,
  status,
  version,
  dirty,
  onChanged,
}: {
  productId: string;
  slug: string;
  status: PublicationStatus;
  version: number;
  dirty: boolean;
  onChanged: (product: EditableProduct) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ error: boolean; text: string; conflict?: boolean } | null>(null);

  const change = (target: PublicationStatus, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setMessage(null);
    const formData = new FormData();
    formData.set("productId", productId);
    formData.set("version", String(version));
    formData.set("status", target);
    startTransition(async () => {
      const result = await changeProductStatus(formData);
      if (result.ok) {
        onChanged(result.product);
        setMessage({
          error: false,
          text:
            target === "published"
              ? "Published. It’s now in the shop."
              : target === "archived"
                ? "Archived. It’s hidden from the shop."
                : status === "archived"
                  ? "Restored as a draft."
                  : "Unpublished. It’s hidden from the shop and back to a draft.",
        });
      } else {
        setMessage({ error: true, text: result.error, conflict: result.conflict });
      }
    });
  };

  const buttons: { target: PublicationStatus; label: string; primary?: boolean; confirm?: string }[] =
    status === "draft"
      ? [
          { target: "published", label: "Publish", primary: true },
          { target: "archived", label: "Archive", confirm: "Archive this draft? It stays in the admin list and can be restored." },
        ]
      : status === "published"
        ? [
            { target: "draft", label: "Unpublish", confirm: "Unpublish? Shoppers won’t see it until you publish it again." },
            { target: "archived", label: "Archive", confirm: "Archive this product? It disappears from the shop. You can restore it as a draft later." },
          ]
        : [{ target: "draft", label: "Restore as draft", primary: true }];

  return (
    <section aria-labelledby="status-heading" className="mb-8 flex flex-wrap items-center justify-between gap-4 rounded-lg bg-cream p-5">
      <div>
        <h2 id="status-heading" className="flex items-center gap-2 text-base font-bold">
          Status <PublicationBadge status={status} />
        </h2>
        <p className="mt-1 text-sm text-ink/80">
          {status === "published" ? (
            <>
              Visible in the shop at{" "}
              <Link href={`/products/${slug}`} className="link-underline font-mono text-xs" target="_blank">
                /products/{slug}
              </Link>
            </>
          ) : status === "draft" ? (
            "Only admins can see drafts."
          ) : (
            "Archived products are hidden from the shop and never deleted."
          )}
        </p>
        <p aria-live="polite" className="mt-1 text-sm">
          {message ? (
            <span className={message.error ? "font-medium text-danger" : "text-forest"}>
              {message.text}
              {message.conflict ? (
                <>
                  {" "}
                  <a href="" className="font-semibold underline">
                    Reload
                  </a>
                </>
              ) : null}
            </span>
          ) : dirty ? (
            <span className="text-muted">Save your changes before changing the status.</span>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <button
            key={b.target}
            type="button"
            disabled={pending || dirty}
            onClick={() => change(b.target, b.confirm)}
            className={`btn ${b.primary ? "btn-forest" : "btn-outline"} disabled:opacity-60`}
          >
            {pending ? "Working…" : b.label}
          </button>
        ))}
      </div>
    </section>
  );
}
