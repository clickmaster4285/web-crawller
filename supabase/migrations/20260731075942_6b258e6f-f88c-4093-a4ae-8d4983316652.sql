REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.owns_workspace(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owns_workspace(UUID) TO authenticated, service_role;