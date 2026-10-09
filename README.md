# conty-signup-attribution

API de atribuição de cadastro no app: de qual link (campanha ou indicação) veio cada cadastro, com auditoria de todos os toques considerados. Contrato = este README + os testes em `test/`.

## Como rodar
```
npm install
npm test
npm run typecheck
npm run dev        # PORT (padrão 3006), ATTRIBUTION_WINDOW_DAYS (padrão 7), DB_PATH (padrão: memória)
```
Node 22+, Hono, `node:sqlite`, vitest.

## Contrato do link
`https://app.conty.example/o?t=<campaign|referral>&ref=<código>&cid=<click_id>`

- `t`: tipo do toque. `ref`: código da campanha ou do indicador. `cid`: id único do clique (gerado no redirecionador). `ref` e `cid` aceitam `[A-Za-z0-9_-]`, até 64 caracteres.
- Link de campanha: `https://app.conty.example/o?t=campaign&ref=verao26&cid=clk_01H8X`
- Link de indicação: `https://app.conty.example/o?t=referral&ref=ana_k3&cid=clk_01J2Z`
- Tudo viaja no link; nada depende de referrer (o webview não manda). O host não é verificado.

## Fluxo
1. `POST /app-opens` `{ device_id, opened_at, link? }` grava `first_open_at` na primeira vez (aberturas repetidas mantêm o primeiro valor) e, se houver `link`, o toque no próprio `opened_at`. 201 na primeira, 200 nas seguintes.
2. `POST /touches` `{ device_id, touched_at, link }` toques seguintes. Mesmo `click_id` no mesmo dispositivo responde 200 `{"duplicate": true}`. 404 se o dispositivo nunca abriu o app; 409 se o dispositivo já tem cadastro.
3. `POST /signups` `{ device_id, user_id, signed_up_at }` decide a origem uma vez e grava. 201 na criação; repetir o mesmo corpo devolve 200 com o mesmo resultado (nada é recalculado). Mesmo `user_id` com outro dispositivo/horário, ou dispositivo de outro usuário: 409. Cadastro anterior à primeira abertura: 422.
4. `GET /signups/:user_id/attribution` auditoria (snapshot gravado no momento da decisão).

Todo horário exige fuso explícito (`Z` ou `±hh:mm`), precisão de ms; sem fuso é 400. Os horários vêm no payload (o relógio do servidor só carimba `recorded_at`).

## Qual toque vence (last-touch) e por quê
**Vence o último toque válido.** Escolhemos last-touch porque o link mais recente é a intenção mais próxima do cadastro, e porque é a regra mais simples de explicar e auditar (uma ordenação por horário).

Um toque é válido se `first_open_at <= touch_at <= min(signed_up_at, first_open_at + janela)`.

- **Janela: 7 dias** (`ATTRIBUTION_WINDOW_DAYS`), medidos da **primeira abertura** (não do clique), em múltiplos de 24 h (sem ajuste de horário de verão). Limite **inclusivo**: `first_open + 7d` vale; `first_open + 7d + 1 ms` é `outside_window`.
- Toque depois do cadastro nunca conta (`after_signup`). Se o toque está depois do cadastro **e** depois da janela, a classificação é `after_signup` (checado primeiro). Toque antes da primeira abertura é `before_first_open`.
- **Desempate de horário idêntico** (mesmo milissegundo): `referral` vence `campaign`; persistindo, vence o `click_id` menor (ordem lexicográfica). O perdedor é `lost_tie_break`. Quem tem horário anterior ao vencedor é `lost_to_later_touch`.
- **Mesmo clique**: `UNIQUE(device_id, click_id)`. O primeiro registro a chegar é o canônico; as repetições ficam guardadas só para a auditoria (`duplicate`) e não geram outra origem.
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
    { "click_id": "clk_01J", "type": "referral", "ref": "ana_k3", "touched_at": "2026-03-03T12:05:00.000Z", "outcome": "duplicate", "reason": "click_id clk_01J repetido; só o primeiro registro conta" }
  ]
}
```
Valores de `outcome`: `winner`, `lost_to_later_touch`, `lost_tie_break`, `outside_window`, `after_signup`, `before_first_open`, `duplicate`.

## Decisões adicionais
- A decisão é imutável: depois do cadastro, `POST /touches` do dispositivo dá 409 (não reescrevemos história). Toque com `touched_at` posterior ao cadastro mas enviado antes dele é aceito e aparece como `after_signup`.
- Cadastro de dispositivo sem abertura registrada não falha: vira `organic/no_app_open`.
- Os toques ficam na auditoria ordenados por `touched_at`.

## Fora de escopo
Assinatura/HMAC do link (qualquer um pode forjar um link), fraude de clique, vários dispositivos por usuário (um dispositivo por cadastro), redirecionador que gera o `cid`, autenticação da API.

## Uso de IA
- **Feito com IA:** especificação, código e testes escritos com Claude Code (Claude Sonnet 5.5), a partir de decisões do autor tomadas em entrevista (grill) e registradas em `.specs/`.
- **Revisado pelo autor:** TODO(preencher após a revisão humana do diff).
- **Revisão independente:** TODO(preencher após a revisão por agente de contexto limpo).
