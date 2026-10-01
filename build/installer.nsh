!macro LumenRegister KEY TARGET
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Lumen.Open" "" "Open with Lumen"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Lumen.Open" "Icon" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0'
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Lumen.Open" "MultiSelectModel" "Document"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Lumen.Open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open $\"${TARGET}$\"'
!macroend

!macro LumenUnregister KEY TARGET
  ReadRegStr $0 HKCU "Software\Classes\${KEY}\shell\Lumen.Open\command" ""
  ${If} $0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open $\"${TARGET}$\"'
    DeleteRegKey HKCU "Software\Classes\${KEY}\shell\Lumen.Open"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro LumenRegister "*" "%1"
  !insertmacro LumenRegister "Directory" "%1\."
  !insertmacro LumenRegister "Directory\Background" "%V\."
  !insertmacro LumenRegister "Drive" "%1\."
  System::Call 'shell32::SHChangeNotify(i, i, p, p) v (0x08000000, 0x1000, 0, 0)'
!macroend

!macro customUnInstall
  !insertmacro LumenUnregister "*" "%1"
  !insertmacro LumenUnregister "Directory" "%1\."
  !insertmacro LumenUnregister "Directory\Background" "%V\."
  !insertmacro LumenUnregister "Drive" "%1\."
  System::Call 'shell32::SHChangeNotify(i, i, p, p) v (0x08000000, 0x1000, 0, 0)'
!macroend
