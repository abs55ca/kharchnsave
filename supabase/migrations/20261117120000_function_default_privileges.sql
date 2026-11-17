-- New functions are callable only by the roles they are granted to.
--
-- PostgreSQL gives EXECUTE on every new function to PUBLIC (every role,
-- including anon and authenticated) unless the creating role's GLOBAL default
-- privileges say otherwise, and Supabase adds schema defaults in public that
-- grant new functions to anon, authenticated and service_role. A schema-level
-- default can only add to the global one, so the statement in
-- 20261031120000_inventory_ledger.sql
--   alter default privileges in schema private revoke execute on functions from public;
-- had no effect: a new private function was still executable by anon and
-- authenticated (through PUBLIC), and only the schema's USAGE kept them out.
--
-- These defaults belong to the role running the migration (the SQL Editor
-- and the Supabase CLI run as postgres, which owns every function here); no
-- FOR ROLE clause, so they apply to whoever runs this, like the statements
-- above. They affect functions created from now on only: existing functions
-- keep their grants, and every function in the later migrations grants
-- EXECUTE explicitly to the roles that call it. service_role keeps
-- Supabase's default in public (platform tooling uses it), as do the
-- defaults for tables and sequences, which every migration resets itself.
--
-- If you create a function by hand later (SQL Editor), grant it explicitly:
--   grant execute on function public.my_function(...) to authenticated;

alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
