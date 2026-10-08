-- Retire obsolete tracked symbols. Preserve rows, holdings and stored history.
-- Verified against official DPS company pages on 2026-10-08.
-- AKZO and PSMC delisted; DAWH -> ENGROH; GHNL -> GAL;
-- SHEL -> WAFI; LPCL -> Pakcem, merged into Bestway (BWCL).
begin;
update public.stocks set is_active=false
where symbol in ('AKZO','DAWH','GHNL','LPCL','PSMC','SHEL');
update public.stocks set company_name='Lafarge Pakistan Cement Limited' where symbol='LPCL';
commit;
