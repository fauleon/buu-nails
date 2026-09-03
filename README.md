# Buu Nails — versão oficial 1.0.0

PWA mobile-first para agenda e controle de pagamentos de uma manicure.

## O que já faz

- Perfil administrador da **Manicure Bruna** e perfis de clientes com PIN.
- Cadastro manual de clientes pelo painel da Bruna.
- Reserva de horário sem sobreposição, com duração e valor.
- Reserva semanal por 1 a 6 meses (ou até 24 semanas).
- Visão de agenda da semana, do mês e lista de próximos horários.
- Status financeiro: pendente, comprovante enviado, pago.
- Cliente envia comprovante em imagem; Bruna confirma o pagamento.
- PWA instalável em iOS e Android.

## Rodar localmente

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Abra `http://127.0.0.1:8000`. No primeiro uso, entre como **Manicure Bruna** com o PIN `123456` e troque `ADMIN_PIN` antes da publicação.

## Railway

1. Crie um serviço PostgreSQL e adicione a variável `DATABASE_URL` dele a este serviço.
2. Defina `SECRET_KEY` como uma frase longa aleatória, `ADMIN_PIN` como o PIN privado da Bruna e `COOKIE_SECURE=true`.
3. Para manter comprovantes entre deploys, crie um Volume Railway montado em `/data` e defina `UPLOAD_DIR=/data/uploads`.
4. Faça o deploy. O comando e a rota de saúde já estão definidos em `railway.toml`.

Para apenas seis usuárias, um único serviço Railway e um banco PostgreSQL pequeno são suficientes. Não use o armazenamento temporário do container para comprovantes: ele é apagado em novos deploys.
