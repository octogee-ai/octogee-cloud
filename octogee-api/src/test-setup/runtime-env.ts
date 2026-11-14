process.env.PLATFORM_CREDIT_MARKUP_MULTIPLIER ||= "1";
process.env.PLATFORM_WEB_MARKUP_MULTIPLIER ||= "1";
process.env.APP_URL ||= "https://app-test.octogee.com";
process.env.PUBLIC_APP_ORIGINS ||= "https://octogee.com,https://app.octogee.com,https://www.octogee.com,https://octogee.web.app,https://app-octogee.web.app,https://octogee.firebaseapp.com,https://app-octogee.firebaseapp.com,https://octogee-test.web.app,https://app-test.octogee.com,https://app-octogee-test.web.app,https://octogee-test.firebaseapp.com,https://app-octogee-test.firebaseapp.com";

process.env.BLOB_STORE_BACKEND ||= "gcs";
process.env.BLOB_GCS_BUCKET ||= "unit-test-blobs";
