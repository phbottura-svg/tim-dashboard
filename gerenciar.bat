@echo off
echo ================================
echo   TIM Dashboard - PM2 Manager
echo ================================
echo.
echo  1. Ver status
echo  2. Ver logs em tempo real
echo  3. Reiniciar servidor
echo  4. Parar servidor
echo  5. Iniciar servidor
echo  0. Sair
echo.
set /p op="Escolha: "

if "%op%"=="1" pm2 list
if "%op%"=="2" pm2 logs tim-dashboard
if "%op%"=="3" pm2 restart tim-dashboard
if "%op%"=="4" pm2 stop tim-dashboard
if "%op%"=="5" pm2 start tim-dashboard

echo.
pause
