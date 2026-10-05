-- Rename sections: 4BSIT1 → 4BSIT MM1, 4BSIT2 → 4BSIT MM2
-- Section names are stored as plain text in several tables — update all of them
-- so students, grades, archives, and requests all stay consistent.
-- Safe to run more than once (renames only match the old names).

begin;

-- 1. Section list (what the professor sees on the Students page)
update sections
   set name = '4BSIT MM1'
 where name = '4BSIT1';

update sections
   set name = '4BSIT MM2'
 where name = '4BSIT2';

-- 2. Student enrollments
update user_profiles
   set section = '4BSIT MM1'
 where section = '4BSIT1';

update user_profiles
   set section = '4BSIT MM2'
 where section = '4BSIT2';

-- 3. Grade snapshots on portfolios (Grade Archives filters on this)
update portfolios
   set section = '4BSIT MM1'
 where section = '4BSIT1';

update portfolios
   set section = '4BSIT MM2'
 where section = '4BSIT2';

-- 4. Frozen grading periods
update archive_freezes
   set section_name = '4BSIT MM1'
 where section_name = '4BSIT1';

update archive_freezes
   set section_name = '4BSIT MM2'
 where section_name = '4BSIT2';

-- 5. Pending/historical section requests
update section_requests
   set from_section = '4BSIT MM1'
 where from_section = '4BSIT1';

update section_requests
   set to_section = '4BSIT MM1'
 where to_section = '4BSIT1';

update section_requests
   set from_section = '4BSIT MM2'
 where from_section = '4BSIT2';

update section_requests
   set to_section = '4BSIT MM2'
 where to_section = '4BSIT2';

commit;

-- Verify: should return 0 rows
select 'sections' as tbl, count(*) as leftover from sections where name in ('4BSIT1','4BSIT2')
union all
select 'user_profiles', count(*) from user_profiles where section in ('4BSIT1','4BSIT2')
union all
select 'portfolios', count(*) from portfolios where section in ('4BSIT1','4BSIT2')
union all
select 'archive_freezes', count(*) from archive_freezes where section_name in ('4BSIT1','4BSIT2')
union all
select 'section_requests', count(*) from section_requests where from_section in ('4BSIT1','4BSIT2') or to_section in ('4BSIT1','4BSIT2');
