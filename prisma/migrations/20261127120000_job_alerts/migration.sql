-- Find jobs alerts: bell notifications without an automation, "New" rows, daily email.
ALTER TABLE "Notification" ALTER COLUMN "automationId" DROP NOT NULL;

ALTER TABLE "JobRankingRow" ADD COLUMN IF NOT EXISTS "foundAt" TIMESTAMP(3);

ALTER TABLE "JobSearch" ADD COLUMN IF NOT EXISTS "emailAlerts" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "JobSearch" ADD COLUMN IF NOT EXISTS "emailMinScore" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "JobSearch" ADD COLUMN IF NOT EXISTS "digestPendingSince" TIMESTAMP(3);
