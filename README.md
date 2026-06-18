# Casa Nova — Lista compartilhada

Lista de compras da casa pra vocês dois usarem no celular. Banco no servidor,
acesso por um código da casa, e PWA (dá pra instalar na tela inicial).

## Stack
- **Node + Express** (servidor)
- **better-sqlite3** (banco, persiste em `casa.sqlite`)
- **Front PWA** em HTML/CSS/JS puro (sem build, sem bundler)

## Rodar local
```bash
npm install
cp .env.example .env      # edite o CASA_CODE
npm start
```
Abra `http://localhost:3000`, digite o código, pronto.

## Subir na Square Cloud
1. Edite o `.env` e defina o `CASA_CODE` (o que vocês dois vão digitar).
2. Zipe a pasta inteira (com `squarecloud.app`, `package.json`, `server.js`, `public/`).
3. Suba o zip no painel da Square Cloud — ela instala e roda sozinha.
4. Pegue a URL que a Square Cloud te der e abra no celular.
5. No celular: menu do navegador › **"Adicionar à tela inicial"** → vira app.

> Os dois usam a **mesma URL** e o **mesmo código**. A lista é única e
> sincroniza: o que um marca como comprado, o outro vê ao abrir/atualizar.

## Variáveis de ambiente
| Variável     | Pra quê                                            |
|--------------|----------------------------------------------------|
| `CASA_CODE`  | Código de entrada (vocês dois digitam o mesmo)     |
| `PORT`       | Porta (a Square Cloud injeta sozinha)              |
| `ML_*`       | Mercado Livre — Fase 2 (busca de preço)            |
| `SHOPEE_*`   | Shopee — Fase 2 (busca de preço)                   |

## Próximas fases
- **Fase 2:** busca de preço no Mercado Livre e Shopee (botão por item).
- Ideias: ordenar por prioridade, foto via upload, "quem comprou".
