-- "Compare all my CVs": the best-fitting CV's score and title, shown beside
-- the job title, and the whole ranked comparison for the AI Match tab.
-- IF NOT EXISTS keeps this safe to re-run.
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "bestResumeScore" INTEGER;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "bestResumeTitle" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "resumeComparison" TEXT;
ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "resumeComparedAt" TIMESTAMP(3);
