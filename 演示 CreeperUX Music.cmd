@echo off
rem CreeperUX Music demo: the demo server and the Windows app. Needs Node.js (and the .NET 10 SDK the first time, to build).
cd /d "%~dp0"
node tools\demo.mjs %*
