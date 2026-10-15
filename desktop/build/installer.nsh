; One signed installer serves both editions (src/edition.js readEdition).
; A copy of it whose file name ends in "-production.exe" marks the install as
; the production edition; renaming a signed file leaves its signature valid.
; The plain name writes nothing, so the installer an update downloads leaves
; an existing mark alone. StrCmp ignores case.
!include "LogicLib.nsh"

!macro customInstall
  StrCpy $0 "$EXEFILE" "" -15
  ${If} $0 == "-production.exe"
    CreateDirectory "$APPDATA\${PRODUCT_NAME}"
    FileOpen $1 "$APPDATA\${PRODUCT_NAME}\EDITION" w
    FileWrite $1 "production"
    FileClose $1
  ${EndIf}
!macroend
