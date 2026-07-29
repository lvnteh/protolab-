// scripts/migrate-uploads-to-supabase.js
// ONE-SHOT: copy every prototype .html from the local UPLOADS_PATH volume into
// Supabase Storage under the SAME key (basename), idempotently. Storage keys are
// flat basenames (`<id>.html`) identical on both backends, so this preserves all
// share links. Covers BOTH prototype files and version files, because it walks
// the volume directory rather than reconciling DB rows.
//
// Run INSIDE the Railway container (the /data volume only exists there):
//   railway ssh -- node scripts/migrate-uploads-to-supabase.js
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment. Safe to
// re-run: uploads use upsert, and we skip objects already present with same size.
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const UPLOADS = process.env.UPLOADS_PATH || './uploads';
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'prototypes';

if (!URL || !KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(URL, KEY);

async function ensureBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets.some((b) => b.name === BUCKET)) {
    console.log(`Bucket "${BUCKET}" absent — creating (private).`);
    const { error: cErr } = await supabase.storage.createBucket(BUCKET, { public: false });
    if (cErr) throw cErr;
  } else {
    console.log(`Bucket "${BUCKET}" exists.`);
  }
}

async function remoteSize(key) {
  // list with a search on the exact name; returns metadata.size when present.
  const { data, error } = await supabase.storage.from(BUCKET).list('', { search: key, limit: 100 });
  if (error) return null;
  const hit = (data || []).find((o) => o.name === key);
  return hit && hit.metadata ? hit.metadata.size : null;
}

async function main() {
  await ensureBucket();

  let files;
  try {
    files = fs.readdirSync(UPLOADS).filter((f) => f.endsWith('.html'));
  } catch (e) {
    console.error(`Cannot read UPLOADS_PATH="${UPLOADS}": ${e.message}`);
    process.exit(1);
  }
  console.log(`Found ${files.length} .html file(s) under ${UPLOADS}.`);

  let uploaded = 0; let skipped = 0; let failed = 0;
  for (const name of files) {
    const abs = path.join(UPLOADS, name);
    const stat = fs.statSync(abs);
    const existing = await remoteSize(name);
    if (existing !== null && existing === stat.size) {
      skipped++;
      continue;
    }
    const body = fs.readFileSync(abs);
    const { error } = await supabase.storage.from(BUCKET)
      .upload(name, body, { contentType: 'text/html', upsert: true });
    if (error) {
      console.error(`  FAIL ${name}: ${error.message}`);
      failed++;
    } else {
      uploaded++;
    }
  }

  // Verify: every local file must now exist remotely.
  let missing = 0;
  for (const name of files) {
    const sz = await remoteSize(name);
    if (sz === null) { console.error(`  MISSING after upload: ${name}`); missing++; }
  }

  console.log(`\nDone. uploaded=${uploaded} skipped=${skipped} failed=${failed} local=${files.length} missing=${missing}`);
  if (failed > 0 || missing > 0) {
    console.error('MIGRATION INCOMPLETE — do NOT set Supabase vars permanently yet.');
    process.exit(1);
  }
  console.log('MIGRATION VERIFIED — all local files present in Supabase.');
}

main().catch((e) => { console.error('Migration crashed:', e); process.exit(1); });
