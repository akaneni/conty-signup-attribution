# conty-signup-attribution

API de atribuição de cadastro no app: de qual link (campanha ou indicação) veio cada cadastro, com auditoria de todos os toques considerados. Contrato = este README + os testes em `test/`.

## Como rodar
```
npm install
npm test
npm run typecheck
npm run dev        # PORT (padrão 3006), ATTRIBUTION_WINDOW_DAYS (padrão 7), DB_PATH (padrão: memória)
```
Node 22.13+ (`node:sqlite` sem flag), Hono, vitest. Só foi verificado no Node 24.

## Contrato do link
`https://app.conty.example/o?t=<campaign|referral>&ref=<código>&cid=<click_id>`

- `t`: tipo do toque. `ref`: código da campanha ou do indicador. `cid`: id único do clique (gerado no redirecionador). `ref` e `cid` aceitam `[A-Za-z0-9_-]`, até 64 caracteres.
- Link de campanha: `https://app.conty.example/o?t=campaign&ref=verao26&cid=clk_01H8X`
- Link de indicação: `https://app.conty.example/o?t=referral&ref=ana_k3&cid=clk_01J2Z`
- Tudo viaja no link; nada depende de referrer (o webview não manda). O host não é verificado.

## Fluxo
1. `POST /app-opens` `{ device_id, opened_at, link? }` grava `first_open_at` na primeira vez. Abertura repetida com `opened_at` mais antigo (abertura atrasada, ex.: app offline) **recua** o `first_open_at` para o menor valor, e a janela acompanha; isso só vale antes do cadastro, depois dele o valor e a decisão gravados não mudam. Abertura mais nova não altera nada e, se houver `link`, o toque no próprio `opened_at`. 201 na primeira, 200 nas seguintes.
2. `POST /touches` `{ device_id, touched_at, link }` toques seguintes. Mesmo `click_id` no mesmo dispositivo responde 200 `{"duplicate": true}`. 404 se o dispositivo nunca abriu o app: o toque que chega antes de qualquer `POST /app-opens` é rejeitado e perdido (é o contrato; o app deve registrar a abertura primeiro). Se o dispositivo já tem cadastro o toque é aceito (201, ou 200 se repetido), gravado com `received_at` e só aparece na auditoria; a decisão não muda (ver abaixo).
3. `POST /signups` `{ device_id, user_id, signed_up_at }` decide a origem uma vez e grava. 201 na criação; repetir o mesmo corpo devolve 200 com o mesmo resultado (nada é recalculado). Mesmo `user_id` com outro dispositivo/horário, ou dispositivo de outro usuário: 409. Cadastro com `signed_up_at` anterior ao `first_open_at` (um cadastro não pode preceder a abertura que o originou, e a janela ficaria sem sentido): 422.
4. `GET /signups/:user_id/attribution` auditoria (snapshot gravado no momento da decisão).

Toque que chega depois do cadastro (por `POST /touches` ou por `POST /app-opens` com link) nunca reavalia a decisão gravada.

Todo horário exige fuso explícito (`Z`, `±hh:mm` ou `±hhmm`), precisão de ms (até 3 casas); sem fuso é 400. Cada componente é validado por faixa, sem rolar para o dia seguinte: ano 1000-9999, mês 1-12, dia existente no mês (bissexto incluso), hora 0-23 (`T24:00:00Z` é 400), minuto e segundo 0-59, fuso de -23:59 a +23:59 (`+24:00` e `+03:60` são 400). Os horários vêm no payload (o relógio do servidor só carimba `recorded_at`).

## Qual toque vence (last-touch) e por quê
**Vence o último toque válido.** Escolhemos last-touch porque o link mais recente é a intenção mais próxima do cadastro, e porque é a regra mais simples de explicar e auditar (uma ordenação por horário).

Um toque é válido se `first_open_at <= touch_at <= min(signed_up_at, first_open_at + janela)`.

- **Janela: 7 dias** (`ATTRIBUTION_WINDOW_DAYS`), medidos da **primeira abertura** (não do clique), em múltiplos de 24 h (sem ajuste de horário de verão). Limite **inclusivo**: `first_open + 7d` vale; `first_open + 7d + 1 ms` é `outside_window`.
- Toque depois do cadastro nunca conta (`after_signup`). Se o toque está depois do cadastro **e** depois da janela, a classificação é `after_signup` (checado primeiro). Toque antes da primeira abertura é `before_first_open`.
- **Desempate de horário idêntico** (mesmo milissegundo): `referral` vence `campaign`; persistindo, vence o `click_id` menor (ordem lexicográfica). O perdedor é `lost_tie_break`. Quem tem horário anterior ao vencedor é `lost_to_later_touch`.
- **Mesmo clique**: um registro canônico por `(device_id, click_id)`: o de **`touched_at` mais antigo**, qualquer que seja a ordem de chegada. **Desempate total entre repetições** (determinístico, independe da ordem de chegada): `touched_at` mais antigo; em empate exato, `referral` antes de `campaign`; em novo empate, `ref` lexicograficamente menor. Se um repetido que vença por esse critério chegar depois, ele vira o canônico (`POST /touches` responde 200 com `duplicate: false, replaced_canonical: true`) e o antigo vira `duplicate`. Depois do cadastro nada troca a decisão gravada. As repetições ficam só na auditoria (`duplicate`); se `type` ou `ref` divergirem do canônico, o `reason` diz isso. Não geram outra origem.
- **Sem toque válido**: `source = "organic"` e `reason` gravado: `no_touches`, `all_outside_window`, `all_after_signup`, `all_before_first_open`, `no_valid_touches` (toques inválidos por motivos diferentes), `no_app_open` (dispositivo sem abertura registrada).

## Exemplo completo
```
curl -X POST localhost:3006/app-opens -H 'content-type: application/json' -d '{"device_id":"dev_1","opened_at":"2026-03-01T12:00:00Z","link":"https://app.conty.example/o?t=campaign&ref=verao26&cid=clk_01H"}'
curl -X POST localhost:3006/touches   -H 'content-type: application/json' -d '{"device_id":"dev_1","touched_at":"2026-03-03T09:00:00-03:00","link":"https://app.conty.example/o?t=referral&ref=ana_k3&cid=clk_01J"}'
curl -X POST localhost:3006/signups   -H 'content-type: application/json' -d '{"device_id":"dev_1","user_id":"user_1","signed_up_at":"2026-03-04T10:00:00Z"}'
curl localhost:3006/signups/user_1/attribution
```
Resposta da auditoria (abreviada; `touches` traz todos os toques, com `outcome` e `reason`):
```json
{
  "user_id": "user_1", "device_id": "dev_1",
  "signed_up_at": "2026-03-04T10:00:00.000Z", "recorded_at": "...",
  "attribution": { "source": "referral", "ref": "ana_k3", "click_id": "clk_01J", "reason": "toque válido mais recente (2026-03-03T12:00:00.000Z)" },
  "window": { "days": 7, "first_open_at": "2026-03-01T12:00:00.000Z", "ends_at": "2026-03-08T12:00:00.000Z", "valid_until": "2026-03-04T10:00:00.000Z" },
  "touches": [
    { "click_id": "clk_01H", "type": "campaign", "ref": "verao26", "touched_at": "2026-03-01T12:00:00.000Z", "outcome": "lost_to_later_touch", "reason": "válido, mas o toque clk_01J é mais recente (2026-03-03T12:00:00.000Z)" },
    { "click_id": "clk_01J", "type": "referral", "ref": "ana_k3", "touched_at": "2026-03-03T12:00:00.000Z", "outcome": "winner", "reason": "toque válido mais recente (2026-03-03T12:00:00.000Z)" },
    { "click_id": "clk_01J", "type": "referral", "ref": "ana_k3", "touched_at": "2026-03-03T12:05:00.000Z", "outcome": "duplicate", "reason": "click_id clk_01J repetido; só o registro de touched_at mais antigo conta" }
  ]
}
```
Toques recebidos depois do cadastro vêm no fim de `touches`, com `touched_at` e `received_at` (horário do servidor, relógio injetado) e `outcome: "received_after_signup"`; o `reason` distingue (a) link aberto depois do cadastro (`touched_at` posterior; não conta) e (b) toque anterior ao cadastro recebido tarde, por exemplo app offline (a decisão já estava gravada e não foi reavaliada). Repetição de `click_id` depois do cadastro aparece como `duplicate`, também com `received_at`. Os toques da decisão original não têm `received_at` e seguem como estavam, inclusive `after_signup` (toque enviado antes do cadastro com `touched_at` posterior).

Valores de `outcome`: `winner`, `lost_to_later_touch`, `lost_tie_break`, `outside_window`, `after_signup`, `before_first_open`, `duplicate`, `received_after_signup` (só para toques recebidos após o cadastro).

## Decisões adicionais
- A decisão é imutável: toque recebido depois do cadastro é aceito e auditado, mas nunca reavalia nem troca o vencedor, mesmo se for mais recente ou de tipo com prioridade maior.
- Duplicado que chega depois do cadastro nunca substitui um canônico anterior a ele (a decisão gravada é imutável).
- O `reason` de repetidos tardios cita o canônico **atual** no momento da leitura da auditoria (o canônico dos tardios pode mudar se chegar outro repetido tardio que o vença); o snapshot da decisão original não muda.
- Toque tardio não é avaliado contra a janela: só registramos que chegou e por quê não conta.
- Cadastro de dispositivo sem abertura registrada não falha: vira `organic/no_app_open`.
- Os toques ficam na auditoria ordenados por `touched_at`.

## Fora de escopo
Reavaliar a atribuição quando chega toque tardio (b) com `touched_at` válido, assinatura/HMAC do link (qualquer um pode forjar um link), fraude de clique, vários dispositivos por usuário (um dispositivo por cadastro), redirecionador que gera o `cid`, autenticação da API.

## Uso de IA
- **Feito com IA:** especificação, código e testes escritos com Claude Code (Claude Sonnet 5.5), a partir de decisões do autor tomadas em entrevista (grill) e registradas em `.specs/`.
- **Revisado pelo autor:** as decisões de regra foram tomadas pelo autor em entrevista (grill) e revisadas por ele. O autor **não leu o código linha a linha**; leu os relatórios de revisão e os pontos de risco apontados.
- **Revisão independente:** 2 revisões independentes por agente de IA de contexto limpo, em modo somente leitura, que rodou os testes, seguiu o README do zero, tentou quebrar as regras com casos adversariais e fez mutações. Os achados foram corrigidos; os ajustes posteriores à segunda revisão (desempate total, migração, ordem dos toques tardios e validação estrita de datas) não foram reavaliados por revisor, só pelos testes.
