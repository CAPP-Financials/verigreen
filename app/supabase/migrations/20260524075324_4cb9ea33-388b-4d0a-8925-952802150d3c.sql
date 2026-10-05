
revoke execute on function public.is_org_member(uuid, uuid) from anon, public;
revoke execute on function public.has_role(uuid, uuid, public.app_role) from anon, public;
revoke execute on function public.has_any_role(uuid, uuid, public.app_role[]) from anon, public;
revoke execute on function public.touch_document_status() from anon, public, authenticated;
revoke execute on function public.handle_new_user() from anon, public, authenticated;
grant execute on function public.is_org_member(uuid, uuid) to authenticated;
grant execute on function public.has_role(uuid, uuid, public.app_role) to authenticated;
grant execute on function public.has_any_role(uuid, uuid, public.app_role[]) to authenticated;
