-- ==============================================================================
-- RemoteMatch (BYN Architecture) — Row Level Security (RLS) Migration
-- Enforces Multi-Tenant Isolation, Client Boundary Defense, and Event Immutability
-- ==============================================================================

-- Ensure Supabase standard roles exist if running in self-hosted or test Postgres
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

-- 1. PROFILES (Person Layer)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_own"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "profiles_insert_own"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_delete_own"
  ON profiles FOR DELETE
  USING (auth.uid() = id);

-- 2. PROFILE INTENTS (Intent Layer)
ALTER TABLE profile_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY "profile_intents_select_own"
  ON profile_intents FOR SELECT
  USING (auth.uid() = profile_id);

CREATE POLICY "profile_intents_insert_own"
  ON profile_intents FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_intents_update_own"
  ON profile_intents FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_intents_delete_own"
  ON profile_intents FOR DELETE
  USING (auth.uid() = profile_id);

-- 3. PROFILE SKILLS
ALTER TABLE profile_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_skills FORCE ROW LEVEL SECURITY;

CREATE POLICY "profile_skills_select_own"
  ON profile_skills FOR SELECT
  USING (auth.uid() = profile_id);

CREATE POLICY "profile_skills_insert_own"
  ON profile_skills FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_skills_update_own"
  ON profile_skills FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_skills_delete_own"
  ON profile_skills FOR DELETE
  USING (auth.uid() = profile_id);

-- 4. PROFILE EXPERIENCES
ALTER TABLE profile_experiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_experiences FORCE ROW LEVEL SECURITY;

CREATE POLICY "profile_experiences_select_own"
  ON profile_experiences FOR SELECT
  USING (auth.uid() = profile_id);

CREATE POLICY "profile_experiences_insert_own"
  ON profile_experiences FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_experiences_update_own"
  ON profile_experiences FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_experiences_delete_own"
  ON profile_experiences FOR DELETE
  USING (auth.uid() = profile_id);

-- 5. PROFILE LOCATIONS
ALTER TABLE profile_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_locations FORCE ROW LEVEL SECURITY;

CREATE POLICY "profile_locations_select_own"
  ON profile_locations FOR SELECT
  USING (auth.uid() = profile_id);

CREATE POLICY "profile_locations_insert_own"
  ON profile_locations FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_locations_update_own"
  ON profile_locations FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "profile_locations_delete_own"
  ON profile_locations FOR DELETE
  USING (auth.uid() = profile_id);

-- 6. OPPORTUNITIES (Canonical Opportunity Supply)
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities FORCE ROW LEVEL SECURITY;

-- Anyone (authenticated or anon) can read active opportunities
CREATE POLICY "opportunities_select_active"
  ON opportunities FOR SELECT
  USING (status = 'active');

-- Mutating opportunities is restricted exclusively to service_role
CREATE POLICY "opportunities_manage_service_role"
  ON opportunities FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- 7. SWIPES
ALTER TABLE swipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE swipes FORCE ROW LEVEL SECURITY;

CREATE POLICY "swipes_select_own"
  ON swipes FOR SELECT
  USING (auth.uid() = profile_id);

CREATE POLICY "swipes_insert_own"
  ON swipes FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "swipes_update_own"
  ON swipes FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "swipes_delete_own"
  ON swipes FOR DELETE
  USING (auth.uid() = profile_id);

-- 8. MATCHES (Screening Fit Score + Explainable Intelligence)
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches FORCE ROW LEVEL SECURITY;

CREATE POLICY "matches_select_own"
  ON matches FOR SELECT
  USING (auth.uid() = profile_id);

CREATE POLICY "matches_insert_own"
  ON matches FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "matches_update_own"
  ON matches FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "matches_delete_own"
  ON matches FOR DELETE
  USING (auth.uid() = profile_id);

-- 9. APPLICATIONS (Tracker)
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications FORCE ROW LEVEL SECURITY;

CREATE POLICY "applications_select_own"
  ON applications FOR SELECT
  USING (auth.uid() = profile_id);

CREATE POLICY "applications_insert_own"
  ON applications FOR INSERT
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "applications_update_own"
  ON applications FOR UPDATE
  USING (auth.uid() = profile_id)
  WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "applications_delete_own"
  ON applications FOR DELETE
  USING (auth.uid() = profile_id);

-- 10. APPLICATION FEEDBACK ("Did you apply?" outcome loop)
ALTER TABLE application_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY "feedback_select_own"
  ON application_feedback FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = application_feedback.application_id
        AND applications.profile_id = auth.uid()
    )
  );

CREATE POLICY "feedback_insert_own"
  ON application_feedback FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = application_feedback.application_id
        AND applications.profile_id = auth.uid()
    )
  );

CREATE POLICY "feedback_update_own"
  ON application_feedback FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = application_feedback.application_id
        AND applications.profile_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = application_feedback.application_id
        AND applications.profile_id = auth.uid()
    )
  );

CREATE POLICY "feedback_delete_own"
  ON application_feedback FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = application_feedback.application_id
        AND applications.profile_id = auth.uid()
    )
  );

-- 11. APPLICATION EVENTS (Outcome Flywheel — Strictly Append-Only / Immutable)
ALTER TABLE application_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_events FORCE ROW LEVEL SECURITY;

CREATE POLICY "events_select_own"
  ON application_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = application_events.application_id
        AND applications.profile_id = auth.uid()
    )
  );

CREATE POLICY "events_insert_own"
  ON application_events FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = application_events.application_id
        AND applications.profile_id = auth.uid()
    )
  );

-- Events are immutable: NO UPDATE and NO DELETE policies are granted to authenticated users.

-- 12. GENERATED MATERIALS (Application Kit)
ALTER TABLE generated_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_materials FORCE ROW LEVEL SECURITY;

CREATE POLICY "materials_select_own"
  ON generated_materials FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = generated_materials.application_id
        AND applications.profile_id = auth.uid()
    )
  );

CREATE POLICY "materials_insert_own"
  ON generated_materials FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = generated_materials.application_id
        AND applications.profile_id = auth.uid()
    )
  );

CREATE POLICY "materials_update_own"
  ON generated_materials FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = generated_materials.application_id
        AND applications.profile_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = generated_materials.application_id
        AND applications.profile_id = auth.uid()
    )
  );

CREATE POLICY "materials_delete_own"
  ON generated_materials FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM applications
      WHERE applications.id = generated_materials.application_id
        AND applications.profile_id = auth.uid()
    )
  );
