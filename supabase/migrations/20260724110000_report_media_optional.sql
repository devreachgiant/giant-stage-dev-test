-- Attaching a screenshot/video to a Help Us Improve report is no longer required.
ALTER TABLE "public"."reports"
    ALTER COLUMN "media_url" DROP NOT NULL,
    ALTER COLUMN "media_type" DROP NOT NULL;
