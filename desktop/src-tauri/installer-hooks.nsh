!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$LOCALAPPDATA\KeeMASH\uninstall.exe" 0 keemash_legacy_migration_done
  DetailPrint "Migrating the legacy per-user KeeMASH installation"
  ExecWait '"$LOCALAPPDATA\KeeMASH\uninstall.exe" /S' $0
  IntCmp $0 0 keemash_legacy_migration_done keemash_legacy_migration_failed keemash_legacy_migration_failed

keemash_legacy_migration_failed:
  MessageBox MB_ICONSTOP|MB_OK "The previous per-user KeeMASH installation could not be removed (exit code $0). Your profile was not changed."
  Abort

keemash_legacy_migration_done:
!macroend
