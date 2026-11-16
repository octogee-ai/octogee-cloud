#!/usr/bin/env bash

octogee_cloud_sql_backup_policy_matches() {
  jq -e --arg region "$1" --argjson pitr "$2" '
    .region == $region and
    .settings.backupConfiguration.pointInTimeRecoveryEnabled == $pitr and
    ($pitr == false or (
      .settings.backupConfiguration.enabled == true and
      (.settings.backupConfiguration.startTime | strings | length) > 0 and
      (.settings.backupConfiguration.transactionLogRetentionDays | numbers) >= 7 and
      (.settings.backupConfiguration.backupRetentionSettings.retainedBackups | numbers) >= 7 and
      .settings.retainBackupsOnDelete == true and
      .settings.deletionProtectionEnabled == true
    ))
  ' >/dev/null
}
