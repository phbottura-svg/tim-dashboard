@echo off
echo Configurando inicialização automática...
schtasks /create /tn "Dashboard TIM" /tr "C:\Users\Paulo\Documents\Claude\tim-dashboard\iniciar.bat" /sc onlogon /ru Paulo /f
echo Pronto! O dashboard vai iniciar automaticamente quando o Windows ligar.
pause
