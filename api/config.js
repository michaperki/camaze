// Public client config — Supabase URL/anon key are safe to expose (RLS
// enforces access, not secrecy of the anon key). Lets the static frontend
// pick up SUPABASE_URL/SUPABASE_ANON_KEY without a build step.
module.exports = async (req, res) => {
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  });
};
