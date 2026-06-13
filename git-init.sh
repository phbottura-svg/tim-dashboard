#!/bin/bash
# Inicializa o repositório Git para deploy no Coolify
# Execute uma vez dentro da pasta tim-dashboard

git init
git add .
git commit -m "Dashboard TIM inicial"

echo ""
echo "Repositório iniciado!"
echo "Agora crie um repositório privado no GitHub/GitLab e rode:"
echo "  git remote add origin https://github.com/SEU_USUARIO/tim-dashboard.git"
echo "  git push -u origin main"
