@echo off
setlocal

set APP_HOME=%~dp0
set CLASSPATH=%APP_HOME%gradle\wrapper\gradle-wrapper.jar

if not "%JAVA_HOME%"=="" goto foundJavaHome
set JAVA_EXE=java.exe
goto execute

:foundJavaHome
set JAVA_EXE=%JAVA_HOME%\bin\java.exe

:execute
"%JAVA_EXE%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*

endlocal

