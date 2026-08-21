-- ============================================================================
-- Koza — kimlik doğrulamayı Supabase Auth (anonymous sign-in) üzerine taşır.
--
-- Önce: kimlik, RPC'lere parametre olarak geçiliyordu (p_user_id,
-- p_sender_user_id, p_accepted_user_id). Fonksiyonlar SECURITY DEFINER olduğu
-- ve `anon` rolüne açık olduğu için, çağıran taraf istediği kimliği beyan
-- edebiliyordu. 8 tabloda RLS açıktı ama tek bir policy yoktu.
--
-- Sonra: kimlik auth.uid()'den gelir, tablolar gerçek RLS policy'leri ile
-- korunur, fonksiyonların çoğu SECURITY INVOKER olur. SECURITY DEFINER yalnız
-- çağıranın henüz erişim hakkı olmadığı iki yerde kalır (odaya katılma ve
-- eşleştirme), oralarda kontrol fonksiyonun içinde açıkça yapılır.
--
-- Ön koşul: Supabase Dashboard → Authentication → Sign In / Providers →
-- "Allow anonymous sign-ins" açık olmalı. İstemci supabase.auth
-- .signInAnonymously() çağırmadan hiçbir RPC çalışmaz.
--
-- Bu migration 0 satır veri üzerinde yazıldı (users/session_rooms/
-- session_messages tamamen boş, yalnız 10 seed topic var). Veri taşıma yok.
-- ============================================================================

-- Not: transaction sarmalayıcı bilerek yok — hem `supabase db push` hem
-- Management API migration'ları kendi transaction'ında çalıştırır.

-- ============================================================================
-- 1. users.id artık auth.users(id)
-- ============================================================================

-- Kimlik artık uygulamanın ürettiği bir UUID değil, Auth oturumunun kimliği.
alter table public.users
  alter column id drop default;

alter table public.users
  add constraint users_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- anon_hash bundan sonra bir kimlik doğrulama aracı değil, yalnızca cihaz
-- tekilleştirme sinyali. Kimlik kanıtı olarak kullanılmamalı.
comment on column public.users.anon_hash is
  'Cihaz tekilleştirme sinyali. Kimlik doğrulama icin KULLANILMAZ - kimlik auth.uid() ile gelir.';

-- ============================================================================
-- 2. Katılımcı kontrolü için yardımcı
-- ============================================================================

-- session_rooms üzerindeki RLS policy'lerinden çağrıldığı için SECURITY
-- DEFINER: aksi halde policy kendi tablosunu okumaya çalışıp sonsuz özyineleme
-- yaratır. Yalnızca boolean döner, satır sızdırmaz.
create or replace function public.is_room_participant(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from session_rooms r
    where r.id = p_room_id
      and (
        r.initiator_user_id = (select auth.uid())
        or r.accepted_user_id = (select auth.uid())
        or (select auth.uid()) = any(r.additional_user_ids)
      )
  );
$$;

-- ============================================================================
-- 3. RLS policy'leri
--
-- auth.uid() her yerde (select auth.uid()) olarak sarmalanmıştır. Postgres
-- bunu satır başına değil sorgu başına bir kez değerlendirir; büyük tablolarda
-- ölçülen fark 100x mertebesindedir.
-- ============================================================================

-- --- users ------------------------------------------------------------------
-- Kullanıcı yalnızca kendi satırını görür ve yönetir. Başka kullanıcıların
-- profillerine erişim get_room_peer() ve find_similar_users() üzerinden,
-- alan kısıtlı olarak verilir.
create policy users_select_own on public.users
  for select to authenticated
  using (id = (select auth.uid()));

create policy users_insert_own on public.users
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy users_update_own on public.users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- --- session_rooms ----------------------------------------------------------
-- Yalnızca katılımcılar. Eşleşme için bekleyen odaların keşfi RLS ile değil,
-- find_waiting_rooms() ile yapılır (alan kısıtlı).
create policy rooms_select_participant on public.session_rooms
  for select to authenticated
  using (public.is_room_participant(id));

create policy rooms_insert_own on public.session_rooms
  for insert to authenticated
  with check (initiator_user_id = (select auth.uid()));

create policy rooms_update_participant on public.session_rooms
  for update to authenticated
  using (public.is_room_participant(id))
  with check (public.is_room_participant(id));

-- --- session_messages -------------------------------------------------------
create policy messages_select_participant on public.session_messages
  for select to authenticated
  using (public.is_room_participant(session_id));

-- Gönderen kimliği artık uydurulamaz: hem auth.uid() olmak hem de odanın
-- katılımcısı olmak zorunda.
create policy messages_insert_own on public.session_messages
  for insert to authenticated
  with check (
    sender_user_id = (select auth.uid())
    and public.is_room_participant(session_id)
  );

-- Mesajlar değiştirilemez ve kullanıcı tarafından silinemez. Silme işini
-- purge fonksiyonları service_role ile yapar.

-- --- topics -----------------------------------------------------------------
-- Referans verisi: herkes okur, kimse yazmaz.
create policy topics_select_all on public.topics
  for select to authenticated
  using (true);

-- --- connection_heartbeat ---------------------------------------------------
create policy heartbeat_select_participant on public.connection_heartbeat
  for select to authenticated
  using (public.is_room_participant(session_id));

create policy heartbeat_write_own on public.connection_heartbeat
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_room_participant(session_id)
  );

create policy heartbeat_update_own on public.connection_heartbeat
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- --- user_deletion_requests -------------------------------------------------
create policy deletion_select_own on public.user_deletion_requests
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy deletion_insert_own on public.user_deletion_requests
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- --- anonymization_log / moderation_queue -----------------------------------
-- Bunlar denetim ve moderasyon kayıtları; hiçbir son kullanıcı erişmemeli.
-- "Policy yok" ile davranış aynı, ama niyeti açıkça yazıyoruz: bu tablolara
-- yalnızca service_role erişir ve bu kasıtlıdır.
create policy anonymization_log_no_user_access on public.anonymization_log
  for all to authenticated, anon
  using (false) with check (false);

create policy moderation_queue_no_user_access on public.moderation_queue
  for all to authenticated, anon
  using (false) with check (false);

-- ============================================================================
-- 4. Fonksiyonların yeniden yazımı
--
-- Kural: kimlik parametresi yok. Kimlik auth.uid()'den gelir.
-- ============================================================================

-- Eski imzalar düşürülüyor. Parametre listesi değiştiği için CREATE OR REPLACE
-- yetmez; eski imza kalırsa güvensiz sürüm çağrılabilir durumda kalır.
drop function if exists public.register_user(text, jsonb, vector, text, text);
drop function if exists public.create_room(uuid, text, uuid, integer);
drop function if exists public.accept_room(uuid, uuid);
drop function if exists public.get_active_room_for_user(uuid);
drop function if exists public.get_room(uuid);
drop function if exists public.send_message(uuid, uuid, text, timestamp);
drop function if exists public.fetch_messages(uuid);
drop function if exists public.end_room(uuid, integer);
drop function if exists public.find_similar_users(vector, uuid, integer, double precision);

-- Kaldırılıyor: Auth oturumu kalıcı olduğu için cihaz kurtarma amacı ortadan
-- kalktı. Kalsaydı, hash'i bilen herkesin user_id çözmesine izin veren bir
-- numaralandırma primitifi olarak dururdu.
drop function if exists public.find_user_by_anon_hash(text);

-- --- register_user ----------------------------------------------------------
create function public.register_user(
  p_anon_hash_hex     text,
  p_onboarding_answers jsonb,
  p_answer_embedding  vector,
  p_voice_preset      text,
  p_avatar_style      text default null
)
returns table(id uuid, voice_preset text, avatar_style text)
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Oturum yok: once supabase.auth.signInAnonymously() cagrilmali';
  end if;

  insert into users (id, anon_hash, onboarding_answers, answer_embedding, voice_preset, avatar_style)
  values (
    (select auth.uid()),
    decode(p_anon_hash_hex, 'hex'),
    p_onboarding_answers,
    p_answer_embedding,
    p_voice_preset,
    p_avatar_style
  );

  return query
  select u.id, u.voice_preset, u.avatar_style
  from users u where u.id = (select auth.uid());
end;
$$;

-- anon_hash artık dönmüyor: istemcinin ona ihtiyacı yok ve kimlik kanıtı
-- gibi kullanılmasının önünü kesiyoruz.

-- --- create_room ------------------------------------------------------------
create function public.create_room(
  p_room_type        text,
  p_topic_id         uuid default null,
  p_duration_minutes integer default 60
)
returns table(id uuid, room_type text, topic_id uuid, initiator_user_id uuid,
              accepted_user_id uuid, status text,
              created_at timestamp without time zone, expires_at timestamp without time zone)
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  new_id uuid;
begin
  insert into session_rooms (initiator_user_id, room_type, topic_id, duration_minutes)
  values ((select auth.uid()), p_room_type, p_topic_id, p_duration_minutes)
  returning session_rooms.id into new_id;

  return query
  select r.id, r.room_type, r.topic_id, r.initiator_user_id, r.accepted_user_id,
         r.status, r.created_at, r.expires_at
  from session_rooms r where r.id = new_id;
end;
$$;

-- --- accept_room ------------------------------------------------------------
-- SECURITY DEFINER kalıyor: çağıran bu noktada henüz katılımcı değil, yani RLS
-- update policy'si onu geçiremez. Yetki kontrolü aşağıda açıkça yapılıyor.
create function public.accept_room(p_room_id uuid)
returns table(id uuid, room_type text, topic_id uuid, initiator_user_id uuid,
              accepted_user_id uuid, status text,
              created_at timestamp without time zone, expires_at timestamp without time zone)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'Oturum yok';
  end if;

  update session_rooms r
  set accepted_user_id = caller,
      status = 'connecting'
  where r.id = p_room_id
    and r.status = 'waiting'
    and r.accepted_user_id is null      -- yarış durumunda ikinci katılımı engeller
    and r.initiator_user_id <> caller;  -- kendi odana katılamazsın

  if not found then
    raise exception 'Oda katilima uygun degil (bulunamadi, dolu, ya da kendi odaniz)';
  end if;

  return query
  select r.id, r.room_type, r.topic_id, r.initiator_user_id, r.accepted_user_id,
         r.status, r.created_at, r.expires_at
  from session_rooms r where r.id = p_room_id;
end;
$$;

-- --- get_room / get_active_room --------------------------------------------
-- Artık katılımcı kontrolü fonksiyonun içinde değil, RLS'te. INVOKER olduğu
-- için katılımcı olmayan çağrıda sonuç boş döner.
create function public.get_room(p_room_id uuid)
returns table(id uuid, room_type text, topic_id uuid, initiator_user_id uuid,
              accepted_user_id uuid, status text,
              created_at timestamp without time zone, expires_at timestamp without time zone)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select r.id, r.room_type, r.topic_id, r.initiator_user_id, r.accepted_user_id,
         r.status, r.created_at, r.expires_at
  from session_rooms r where r.id = p_room_id;
$$;

-- p_user_id parametresi kaldırıldı: "hangi kullanıcı" sorusunun cevabı artık
-- her zaman auth.uid().
create function public.get_active_room()
returns table(id uuid, room_type text, topic_id uuid, initiator_user_id uuid,
              accepted_user_id uuid, status text,
              created_at timestamp without time zone, expires_at timestamp without time zone)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select r.id, r.room_type, r.topic_id, r.initiator_user_id, r.accepted_user_id,
         r.status, r.created_at, r.expires_at
  from session_rooms r
  where (r.initiator_user_id = (select auth.uid()) or r.accepted_user_id = (select auth.uid()))
    and r.status not in ('ended', 'purged')
  order by r.created_at desc
  limit 1;
$$;

-- --- send_message / fetch_messages -----------------------------------------
create function public.send_message(
  p_session_id           uuid,
  p_content_encrypted_hex text,
  p_expires_at           timestamp without time zone
)
returns table(id uuid, session_id uuid, sender_user_id uuid, content_encrypted_hex text,
              has_pii_detected boolean, pii_detected_fields text[],
              created_at timestamp without time zone)
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
  new_id uuid;
begin
  insert into session_messages (session_id, sender_user_id, content_encrypted, expires_at)
  values (p_session_id, (select auth.uid()), decode(p_content_encrypted_hex, 'hex'), p_expires_at)
  returning session_messages.id into new_id;

  return query
  select m.id, m.session_id, m.sender_user_id, encode(m.content_encrypted, 'hex'),
         m.has_pii_detected, m.pii_detected_fields, m.created_at
  from session_messages m where m.id = new_id;
end;
$$;

create function public.fetch_messages(p_session_id uuid)
returns table(id uuid, session_id uuid, sender_user_id uuid, content_encrypted_hex text,
              has_pii_detected boolean, pii_detected_fields text[],
              created_at timestamp without time zone)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select m.id, m.session_id, m.sender_user_id, encode(m.content_encrypted, 'hex'),
         m.has_pii_detected, m.pii_detected_fields, m.created_at
  from session_messages m
  where m.session_id = p_session_id
  order by m.created_at asc;
$$;

-- --- end_room ---------------------------------------------------------------
create function public.end_room(p_room_id uuid, p_actual_duration_seconds integer default null)
returns void
language sql
security invoker
set search_path to 'public'
as $$
  update session_rooms
  set status = 'ended',
      actual_duration_seconds = coalesce(p_actual_duration_seconds, actual_duration_seconds)
  where id = p_room_id;
$$;

-- --- find_similar_users -----------------------------------------------------
-- SECURITY DEFINER kalıyor: eşleştirme, tanımı gereği başka kullanıcıların
-- embedding'lerini okumak zorunda ve users üzerindeki RLS buna izin vermiyor.
-- Dönen alanlar user_id ve benzerlik skoruyla sınırlı; profil sızdırmıyor.
-- exclude_user_id parametresi kaldırıldı: her zaman auth.uid().
create function public.find_similar_users(
  query_embedding vector,
  match_count     integer default 3,
  min_similarity  double precision default 0
)
returns table(user_id uuid, similarity double precision)
language sql
stable
security definer
set search_path to 'public'
as $$
  select u.id, 1 - (u.answer_embedding <=> query_embedding)
  from users u
  where u.id <> (select auth.uid())
    and u.answer_embedding is not null
    and u.is_active
    and not u.is_flagged_for_review
    and (1 - (u.answer_embedding <=> query_embedding)) >= min_similarity
  order by u.answer_embedding <=> query_embedding asc
  limit match_count;
$$;

-- ============================================================================
-- 5. Yeni: eski modelde karşılığı olmayan iki fonksiyon
--
-- session_rooms artık katılımcıyla sınırlı olduğu için, kullanıcının
-- katılabileceği bir odayı bulmasının ve karşı tarafın görünen adını
-- okumasının başka yolu kalmadı. İkisi de alan kısıtlı.
-- ============================================================================

create function public.find_waiting_rooms(
  p_topic_id uuid default null,
  p_limit    integer default 20
)
returns table(id uuid, room_type text, topic_id uuid,
              created_at timestamp without time zone, expires_at timestamp without time zone)
language sql
stable
security definer
set search_path to 'public'
as $$
  select r.id, r.room_type, r.topic_id, r.created_at, r.expires_at
  from session_rooms r
  where r.status = 'waiting'
    and r.accepted_user_id is null
    and r.initiator_user_id <> (select auth.uid())
    and (p_topic_id is null or r.topic_id = p_topic_id)
    and (r.expires_at is null or r.expires_at > now())
  order by r.created_at asc
  limit least(p_limit, 50);
$$;

-- initiator_user_id kasıtlı olarak dönmüyor: odayı kimin açtığı, katılmadan
-- önce bilinmesi gereken bir bilgi değil.

create function public.get_room_peer(p_room_id uuid)
returns table(user_id uuid, voice_preset text, avatar_style text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select u.id, u.voice_preset, u.avatar_style
  from session_rooms r
  join users u on u.id = case
    when r.initiator_user_id = (select auth.uid()) then r.accepted_user_id
    when r.accepted_user_id  = (select auth.uid()) then r.initiator_user_id
  end
  where r.id = p_room_id
    and public.is_room_participant(p_room_id);
$$;

-- ============================================================================
-- 6. Yetkiler
--
-- Kritik adım: `anon` rolü (JWT'siz istek) hiçbir şeye erişemez. Anonim
-- kullanıcılar da signInAnonymously() sonrası `authenticated` rolüyle gelir,
-- dolayısıyla anonimlik kaybolmaz.
-- ============================================================================

-- DİKKAT: burada "revoke all on all functions in schema public" KULLANILMAZ.
-- `vector` extension'ı public şemada kurulu olduğu için o ifade pgvector'ün
-- ~120 operatör fonksiyonunu da kapsar (vector_in / vector_out dahil) ve vector
-- tipini yazılamaz hale getirir; register_user (INVOKER) anında kırılır.
-- Aynı şekilde mask_pii_in_text'e dokunulmaz: detect_and_mask_pii trigger'ı
-- SECURITY DEFINER olmadığı için onu çağıran `authenticated` olur ve EXECUTE
-- yetkisi gider, her send_message permission denied alır.
--
-- Bu yüzden yetkiler yalnızca uygulamanın kendi fonksiyonlarından, tek tek
-- geri alınıyor. Yeni oluşturulan fonksiyonlar Postgres'te varsayılan olarak
-- PUBLIC'e EXECUTE verir; aşağıdaki revoke bunu kapatır.
revoke all on function
  public.register_user(text, jsonb, vector, text, text),
  public.create_room(text, uuid, integer),
  public.accept_room(uuid),
  public.get_room(uuid),
  public.get_active_room(),
  public.send_message(uuid, text, timestamp without time zone),
  public.fetch_messages(uuid),
  public.end_room(uuid, integer),
  public.find_similar_users(vector, integer, double precision),
  public.find_waiting_rooms(uuid, integer),
  public.get_room_peer(uuid),
  public.is_room_participant(uuid)
from anon, public;

-- Bakım/purge fonksiyonları: hepsi SECURITY DEFINER ve şu an PUBLIC'e açık,
-- yani anon key'i olan biri purge_session() çağırıp veri silebiliyor.
-- Bunlar yalnızca scripts/maintenance/*.js tarafından DATABASE_URL ile
-- (postgres rolü) çağrılıyor, dolayısıyla anon/public'ten kaldırmak güvenli.
revoke all on function
  public.purge_session(uuid),
  public.auto_purge_session(),
  public.auto_delete_expired_messages(),
  public.verify_purge_integrity(),
  public.execute_scheduled_user_deletions()
from anon, public, authenticated;

grant execute on function
  public.register_user(text, jsonb, vector, text, text),
  public.create_room(text, uuid, integer),
  public.accept_room(uuid),
  public.get_room(uuid),
  public.get_active_room(),
  public.send_message(uuid, text, timestamp without time zone),
  public.fetch_messages(uuid),
  public.end_room(uuid, integer),
  public.find_similar_users(vector, integer, double precision),
  public.find_waiting_rooms(uuid, integer),
  public.get_room_peer(uuid),
  public.is_room_participant(uuid)
to authenticated;

-- Bakım/purge fonksiyonları yalnızca service_role ile çalışır
-- (scripts/maintenance/*.js zaten DATABASE_URL ile bağlanıyor).

-- İstatistik view'ları anonim isteklere kapalı.
revoke all on public.session_statistics, public.moderation_workload from anon;
