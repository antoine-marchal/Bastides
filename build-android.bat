@echo off
rem ---------------------------------------------------------------------------
rem  Bastides - build an installable Android APK (phones and tablets).
rem
rem  Usage:
rem    build-android.bat            release APK, signed with your local keystore
rem    build-android.bat debug      debug APK (signed with the Android debug key)
rem    build-android.bat sign       sign the existing unsigned release APK
rem
rem  Optional environment variables:
rem    ANDROID_HOME            Android SDK      (default: %LOCALAPPDATA%\Android\Sdk)
rem    NDK_HOME                Android NDK      (default: newest in %ANDROID_HOME%\ndk)
rem    JAVA_HOME               JDK 17+          (default: Android Studio's JBR, else the java on PATH)
rem    ANDROID_PLATFORM / ANDROID_BUILD_TOOLS / ANDROID_NDK
rem                            sdkmanager packages installed when the SDK is incomplete
rem                            (default: platforms;android-36, build-tools;36.0.0, ndk;28.2.13676358)
rem    ANDROID_TARGETS         Rust ABIs        (default: aarch64 armv7)
rem    BASTIDES_KEYSTORE_PASS  keystore password (asked once if not set)
rem
rem  Result: dist-android\Bastides-<version>-<mode>.apk
rem ---------------------------------------------------------------------------
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "MODE=release"
if /i "%~1"=="debug" set "MODE=debug"
if not defined ANDROID_TARGETS set "ANDROID_TARGETS=aarch64 armv7"

echo.
echo === Bastides : APK Android (%MODE%) ===
echo.

rem ---------------------------------------------------------------- tools
for %%T in (node npm rustup cargo) do (
  where %%T >nul 2>nul || ( echo [ERREUR] %%T est introuvable dans le PATH. & goto :fail )
)

rem ---------------------------------------------------------------- JDK
if not defined JAVA_HOME (
  if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
)
if not defined JAVA_HOME (
  rem Ask the java on the PATH where it lives (java.home).
  for /f "tokens=2 delims==" %%J in ('java -XshowSettings:properties -version 2^>^&1 ^| findstr /c:"java.home"') do set "JH=%%J"
  if defined JH set "JAVA_HOME=!JH:~1!"
)
if not defined JAVA_HOME ( echo [ERREUR] Aucun JDK trouve ^(JDK 17 ou plus requis^). Definissez JAVA_HOME. & goto :fail )
set "PATH=%JAVA_HOME%\bin;%PATH%"

rem ---------------------------------------------------------------- Android SDK
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
if not defined ANDROID_PLATFORM    set "ANDROID_PLATFORM=platforms;android-36"
if not defined ANDROID_BUILD_TOOLS set "ANDROID_BUILD_TOOLS=build-tools;36.0.0"
if not defined ANDROID_NDK         set "ANDROID_NDK=ndk;28.2.13676358"
set "SDKMANAGER=%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat"

set "SDK_MISSING="
if not exist "%ANDROID_HOME%\platform-tools" set "SDK_MISSING=1"
if not exist "%ANDROID_HOME%\build-tools" set "SDK_MISSING=1"
if not exist "%ANDROID_HOME%\platforms" set "SDK_MISSING=1"
if not defined NDK_HOME if not exist "%ANDROID_HOME%\ndk" set "SDK_MISSING=1"
if defined SDK_MISSING (
  if not exist "%SDKMANAGER%" (
    echo [ERREUR] SDK Android incomplet et sdkmanager introuvable :
    echo          "%SDKMANAGER%"
    echo          Installez les "Command-line Tools" Android dans "%ANDROID_HOME%\cmdline-tools\latest".
    goto :fail
  )
  echo --- Installation des composants du SDK Android
  echo     Lisez puis acceptez les licences Android ^(repondez y^) :
  call "%SDKMANAGER%" --sdk_root="%ANDROID_HOME%" --licenses || goto :fail
  call "%SDKMANAGER%" --sdk_root="%ANDROID_HOME%" "platform-tools" "%ANDROID_PLATFORM%" "%ANDROID_BUILD_TOOLS%" "%ANDROID_NDK%" || goto :fail
)

if not defined NDK_HOME (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%ANDROID_HOME%\ndk" 2^>nul') do if not defined NDK_HOME set "NDK_HOME=%ANDROID_HOME%\ndk\%%D"
)
if not defined NDK_HOME ( echo [ERREUR] NDK introuvable dans "%ANDROID_HOME%\ndk". & goto :fail )

set "BUILD_TOOLS="
for /f "delims=" %%D in ('dir /b /ad /o-n "%ANDROID_HOME%\build-tools" 2^>nul') do if not defined BUILD_TOOLS set "BUILD_TOOLS=%ANDROID_HOME%\build-tools\%%D"

echo SDK         : %ANDROID_HOME%
echo NDK         : %NDK_HOME%
echo JDK         : %JAVA_HOME%
echo Build-tools : %BUILD_TOOLS%
echo Cibles      : %ANDROID_TARGETS%
echo.

if /i "%~1"=="sign" goto :find_apk

rem Tauri links the native library into the Gradle project with a symbolic link:
rem on Windows this needs Developer Mode (or an administrator prompt).
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense 2>nul | find "0x1" >nul || (
  echo [ATTENTION] Le mode developpeur de Windows semble desactive. Si la compilation
  echo             echoue sur un lien symbolique, activez-le : Parametres ^> Systeme ^>
  echo             Pour les developpeurs ^> Mode developpeur.
  echo.
)

rem ---------------------------------------------------------------- rust targets
set "RUST_TARGETS="
for %%A in (%ANDROID_TARGETS%) do (
  if /i "%%A"=="aarch64" set "RUST_TARGETS=!RUST_TARGETS! aarch64-linux-android"
  if /i "%%A"=="armv7"   set "RUST_TARGETS=!RUST_TARGETS! armv7-linux-androideabi"
  if /i "%%A"=="i686"    set "RUST_TARGETS=!RUST_TARGETS! i686-linux-android"
  if /i "%%A"=="x86_64"  set "RUST_TARGETS=!RUST_TARGETS! x86_64-linux-android"
)
echo --- Cibles Rust
call rustup target add %RUST_TARGETS% || goto :fail

rem ---------------------------------------------------------------- frontend deps + icons
node scripts\sync-app-metadata.mjs || goto :fail
if not exist node_modules (
  echo --- npm install
  call npm install || goto :fail
)
echo --- Icone procedurale
call node scripts\make-icon.mjs --png || goto :fail

rem ---------------------------------------------------------------- android project
if not exist "src-tauri\gen\android" (
  echo --- Initialisation du projet Android
  call npx tauri android init --ci || goto :fail
)
node scripts\prepare-android.mjs || goto :fail
echo --- Icones Android
call npx tauri icon src-tauri\icons\source.png || goto :fail

rem ---------------------------------------------------------------- build
set "TARGET_ARGS="
for %%A in (%ANDROID_TARGETS%) do set "TARGET_ARGS=!TARGET_ARGS! --target %%A"
set "DEBUG_ARG="
if "%MODE%"=="debug" set "DEBUG_ARG=--debug"

echo --- Compilation (plusieurs minutes la premiere fois)
call npx tauri android build --apk --ci %DEBUG_ARG% %TARGET_ARGS% || goto :fail

:find_apk
setlocal DisableDelayedExpansion
set "APK_DIR=src-tauri\gen\android\app\build\outputs\apk\universal\%MODE%"
set "APK="
if "%MODE%"=="release" set "APK=%APK_DIR%\app-universal-release-unsigned.apk"
if "%MODE%"=="debug" (
  for /f "delims=" %%F in ('dir /b /o-d "%APK_DIR%\*.apk" 2^>nul') do if not defined APK set "APK=%APK_DIR%\%%F"
)
if not exist "%APK%" ( echo [ERREUR] Aucun APK trouve dans "%APK_DIR%". & goto :fail )

for /f "delims=" %%V in ('node -p "require('./src-tauri/tauri.conf.json').version"') do set "VERSION=%%V"
if not exist dist-android mkdir dist-android
set "OUT=dist-android\Bastides-%VERSION%-%MODE%.apk"

if "%MODE%"=="debug" (
  copy /y "%APK%" "%OUT%" >nul || goto :fail
  goto :done
)

rem ---------------------------------------------------------------- sign (release)
if not defined BUILD_TOOLS ( echo [ERREUR] Build-Tools introuvables : impossible de signer. & goto :fail )
set "KEYSTORE=src-tauri\android-release.jks"
if not defined BASTIDES_KEYSTORE_PASS (
  set /p "BASTIDES_KEYSTORE_PASS=Mot de passe du keystore (6 caracteres minimum) : "
)
if not defined BASTIDES_KEYSTORE_PASS ( echo [ERREUR] Mot de passe du keystore manquant. & goto :fail )
if not exist "%KEYSTORE%" (
  echo --- Creation du keystore %KEYSTORE%
  keytool -genkeypair -v -keystore "%KEYSTORE%" -alias bastides -keyalg RSA -keysize 2048 -validity 10000 ^
    -storepass:env BASTIDES_KEYSTORE_PASS -keypass:env BASTIDES_KEYSTORE_PASS -dname "CN=Bastides, O=Bastides, C=FR" || goto :fail
  echo [IMPORTANT] Conservez %KEYSTORE% et son mot de passe : ils sont necessaires
  echo             pour publier des mises a jour installables par-dessus cette version.
)
echo --- Alignement et signature
"%BUILD_TOOLS%\zipalign.exe" -f -p 4 "%APK%" "dist-android\aligned.apk" || goto :fail
call "%BUILD_TOOLS%\apksigner.bat" sign --ks "%KEYSTORE%" --ks-key-alias bastides --ks-pass env:BASTIDES_KEYSTORE_PASS --key-pass env:BASTIDES_KEYSTORE_PASS --out "%OUT%" "dist-android\aligned.apk" || goto :fail
del "dist-android\aligned.apk" >nul 2>nul
if exist "%OUT%.idsig" del "%OUT%.idsig" >nul 2>nul
call "%BUILD_TOOLS%\apksigner.bat" verify "%OUT%" || goto :fail

:done
echo.
echo === APK pret : %CD%\%OUT%
echo     Installation sur un appareil branche en USB (debogage USB actif) :
echo     "%ANDROID_HOME%\platform-tools\adb.exe" install -r "%OUT%"
echo.
endlocal
exit /b 0

:fail
echo.
echo === Echec de la creation de l'APK.
endlocal
exit /b 1
