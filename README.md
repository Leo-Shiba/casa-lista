# Casa Nova — Lista compartilhada

Lista do que falta comprar pra casa, compartilhada em tempo real entre quem mora junto.
Funciona no celular como app (PWA, "Adicionar à tela inicial").

## O que tem
- **Contas** com usuário e senha (email opcional pra recuperar senha)
- **Casas compartilhadas**: cada casa tem um código de convite; dá pra participar de várias e trocar entre elas
- **Itens** com cômodo, quantidade, preço, link da loja, foto (câmera, galeria ou puxada do link), notas e ⭐ urgente
- **Tempo real**: o que um marca, o outro vê na hora
- Filtros, busca, arrastar pra reordenar, exportar `.txt`, enviar pelo WhatsApp
- **Histórico** (itens limpos da lista), **estatísticas** de gasto e **atividade** da casa
- **Modo Mercado**: calculadora de compras com conferência de cupom fiscal (OCR no aparelho)
- Tema claro/escuro, `/demo` com dados de exemplo

## Stack
Node + Express, SQLite embutido do Node (`node:sqlite`, arquivo `casa.sqlite`) — sem dependência nativa, front em HTML/CSS/JS puro.

## Rodar local
```bash
npm install
cp .env.example .env   # defina pelo menos JWT_SECRET
npm start              # http://localhost:3000
```

## Square Cloud
No ar em **https://leocasalista.squareweb.app** — deploy automático a cada push na `main`.
`squarecloud.app` já está configurado (512 MB, subdomínio `leocasalista`).
Variáveis de ambiente: defina `JWT_SECRET` (obrigatório) e, se quiser, `APP_URL`, `SMTP_*` e `ML_*` — veja `.env.example`.

> ⚠️ O banco é o arquivo `casa.sqlite` dentro do app. Se apagar o app, a lista vai junto —
> mantenha os snapshots da Square Cloud em dia.
