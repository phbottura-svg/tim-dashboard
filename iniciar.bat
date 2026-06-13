@echo off
title Dashboard VONIXX
cd /d C:\Users\Paulo\Documents\Claude\tim-dashboard
:loop
echo [%time%] Iniciando servidor...
node server.js
echo [%time%] Servidor parou. Reiniciando em 3 segundos...
timeout /t 3 /nobreak >nul
goto loop
