terraform {
  required_providers {
    google = {
      source                = "hashicorp/google"
      version               = ">= 7.40.0"
      configuration_aliases = [google.bootstrap]
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 7.40.0"
    }
  }
}

locals {
  required_services = toset([
    "artifactregistry.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "compute.googleapis.com",
    "eventarc.googleapis.com",
    "firebase.googleapis.com",
    "firebaseextensions.googleapis.com",
    "firebasestorage.googleapis.com",
    "firebaserules.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "identitytoolkit.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "sqladmin.googleapis.com",
    "storage.googleapis.com",
  ])
  github_actions_roles = toset([
    "roles/run.viewer",
    "roles/serviceusage.serviceUsageConsumer",
  ])
  firestore_ttl_fields = {
    "ocTickets.expiresAt"                     = { collection = "ocTickets", field = "expiresAt" }
    "gatewayTickets.expireAt"                 = { collection = "gatewayTickets", field = "expireAt" }
    "gatewayTicketMintLog.expireAt"           = { collection = "gatewayTicketMintLog", field = "expireAt" }
    "openclawControlTickets.expireAt"         = { collection = "openclawControlTickets", field = "expireAt" }
    "openclawControlSessions.expireAt"        = { collection = "openclawControlSessions", field = "expireAt" }
    "modelBrokerUsageEvents.expiresAt"        = { collection = "modelBrokerUsageEvents", field = "expiresAt", disable_indexes = true }
    "modelBrokerUsageWindows.expiresAt"       = { collection = "modelBrokerUsageWindows", field = "expiresAt", disable_indexes = true }
    "modelBrokerWeekWindows.expiresAt"        = { collection = "modelBrokerWeekWindows", field = "expiresAt", disable_indexes = true }
    "modelBrokerSignupOfferBudgets.expiresAt" = { collection = "modelBrokerSignupOfferBudgets", field = "expiresAt", disable_indexes = true }
    "modelBrokerHouseDayWindows.expiresAt"    = { collection = "modelBrokerHouseDayWindows", field = "expiresAt", disable_indexes = true }
    "modelBrokerRateWindows.expiresAt"        = { collection = "modelBrokerRateWindows", field = "expiresAt", disable_indexes = true }
    "usage_models.expiresAt"                  = { collection = "usage_models", field = "expiresAt", disable_indexes = true }
    "opsSupportQuestions.expiresAt"           = { collection = "opsSupportQuestions", field = "expiresAt", disable_indexes = true }
    "productivityApprovals.expireAt"          = { collection = "productivityApprovals", field = "expireAt" }
    "glmOperations.expireAt"                  = { collection = "glmOperations", field = "expireAt" }
  }
}

resource "google_project" "data" {
  provider = google.bootstrap

  name                = var.project_name
  project_id          = var.project_id
  org_id              = var.organization_id
  billing_account     = var.billing_account_id
  auto_create_network = false
  deletion_policy     = var.retirement_mode ? "DELETE" : "PREVENT"

  labels = {
    deployment-target = var.deployment_target
    managed-by        = "terraform"
    region            = var.region
  }
}

resource "google_project_service" "required" {
  for_each = local.required_services

  project            = google_project.data.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_firebase_project" "data" {
  provider = google-beta
  project  = google_project.data.project_id

  depends_on = [google_project_service.required]
}

resource "google_firebase_web_app" "platform" {
  provider = google-beta
  project  = google_project.data.project_id

  display_name    = "Octogee ${var.deployment_target}"
  deletion_policy = var.retirement_mode ? "DELETE" : "PREVENT"

  depends_on = [google_firebase_project.data]
}

data "google_firebase_web_app_config" "platform" {
  provider   = google-beta
  project    = google_project.data.project_id
  web_app_id = google_firebase_web_app.platform.app_id
}

resource "google_project_service_identity" "eventarc" {
  provider = google-beta
  project  = google_project.data.project_id
  service  = "eventarc.googleapis.com"

  depends_on = [google_project_service.required]
}

resource "google_firestore_database" "default" {
  project                           = google_project.data.project_id
  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "OPTIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = var.retirement_mode ? "DELETE_PROTECTION_DISABLED" : "DELETE_PROTECTION_ENABLED"
  deletion_policy                   = var.retirement_mode ? "DELETE" : "ABANDON"

  depends_on = [google_firebase_project.data]
}

resource "google_firestore_field" "ttl" {
  for_each = local.firestore_ttl_fields

  project         = google_project.data.project_id
  database        = google_firestore_database.default.name
  collection      = each.value.collection
  field           = each.value.field
  deletion_policy = var.retirement_mode ? "DELETE" : "ABANDON"

  ttl_config {}

  dynamic "index_config" {
    for_each = try(each.value.disable_indexes, false) ? [true] : []
    content {}
  }
}

resource "google_identity_platform_config" "default" {
  project                    = google_project.data.project_id
  authorized_domains         = var.authorized_domains
  autodelete_anonymous_users = true

  sign_in {
    allow_duplicate_emails = false

    anonymous {
      enabled = false
    }

    email {
      enabled           = true
      password_required = true
    }

    phone_number {
      enabled            = false
      test_phone_numbers = {}
    }
  }

  monitoring {
    request_logging {
      enabled = true
    }
  }

  depends_on = [google_firebase_project.data]
}

resource "google_storage_bucket" "firebase" {
  project                     = google_project.data.project_id
  name                        = "${var.project_id}.firebasestorage.app"
  location                    = var.region
  force_destroy               = var.retirement_mode
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_firebase_storage_bucket" "firebase" {
  provider  = google-beta
  project   = google_project.data.project_id
  bucket_id = google_storage_bucket.firebase.id

  depends_on = [google_firebase_project.data]
}

resource "google_project_iam_member" "github_actions" {
  for_each = local.github_actions_roles

  project = google_project.data.project_id
  role    = each.value
  member  = "serviceAccount:${var.github_actions_service_account}"
}
