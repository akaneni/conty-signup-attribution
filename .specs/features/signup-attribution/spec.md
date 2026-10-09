# Origem do cadastro no app: especificação

## Problema
A Conty investe em convite, comunidade e campanha. Sem origem confiável do cadastro o time não sabe o que repetir, e o link costuma abrir num webview sem referrer. Precisamos de um contrato de atribuição: o que viaja no link, o que o app grava na primeira abertura e como o cadastro consome isso, com auditoria.

## Decisões (grill)
- Regra: **último toque válido** (last-touch).
- Janela: `ATTRIBUTION_WINDOW_DAYS` (padrão 7), medida da **primeira abertura** (`first_open_at`), em múltiplos de 24 h.
- Toque válido: `first_open_at <= touch_at <= min(signup_at, first_open_at + janela)`; limite inclusivo.
- O clique que abriu o app é gravado como toque no próprio `first_open_at`.
- Empate de horário: `referral` > `campaign`; persistindo, `click_id` menor (lexicográfico).
- Sem toque válido: `organic` com `reason` gravado.
- Mesmo `click_id` no mesmo dispositivo: uma origem só.
- Tudo viaja no link; não dependemos de referrer.

## Fora de escopo
| Item | Motivo |
| --- | --- |
| Assinatura/HMAC do link | Anti-adulteração é outro desafio |
| Fraude de clique | Exige sinais que não temos |
| Vários dispositivos por usuário | Um dispositivo por cadastro neste contrato |
| Redirecionador que gera `cid` | Só consumimos o `cid` |

## Requisitos
| ID | Requisito (WHEN/THEN/SHALL) | Enunciado |
| --- | --- | --- |
| ATT-01 | WHEN o link segue `/o?t=<campaign\|referral>&ref=<código>&cid=<click_id>` THEN o sistema SHALL extrair tipo, ref e click_id; link malformado SHALL dar 400 | contrato do link |
| ATT-02 | WHEN o app abre pela 1ª vez THEN SHALL gravar `first_open_at` e o toque do link em `first_open_at`; repetir a abertura SHALL manter o `first_open_at` | grava na 1ª abertura |
| ATT-03 | WHEN chegam dois links diferentes antes do cadastro THEN vence o de maior `touch_at` válido; o outro SHALL ser `lost_to_later_touch` | dois links |
| ATT-04 | WHEN dois toques válidos têm o mesmo instante THEN SHALL vencer referral sobre campaign, depois `click_id` menor; o perdedor SHALL ser `lost_tie_break` | empate de horário |
| ATT-05 | WHEN o mesmo `click_id` chega de novo no dispositivo THEN SHALL NOT criar outra origem; aparece como `duplicate` na auditoria | clique repetido |
| ATT-06 | WHEN `touch_at > signup_at` THEN SHALL ser `after_signup` e não vencer | pós-cadastro |
| ATT-07 | WHEN `touch_at > first_open_at + janela` THEN SHALL ser `outside_window`; WHEN `touch_at = first_open_at + janela` THEN SHALL valer | janela explícita |
| ATT-08 | WHEN `touch_at < first_open_at` THEN SHALL ser `before_first_open` | janela medida da 1ª abertura |
| ATT-09 | WHEN não há toque válido THEN `source = organic` e `reason` SHALL ser gravado (`no_touches`, `all_outside_window`, `all_after_signup`, `all_before_first_open`, `no_valid_touches`, `no_app_open`) | orgânico com motivo |
| ATT-10 | WHEN o cadastro se repete (mesmo user_id e mesmo corpo) THEN SHALL devolver a mesma decisão sem recalcular; corpo divergente SHALL dar 409 | idempotência |
| ATT-11 | WHEN se consulta `GET /signups/:user_id/attribution` THEN SHALL listar TODOS os toques com `outcome` e `reason` e a janela usada | auditoria |
| ATT-12 | WHEN um horário vem sem fuso explícito THEN SHALL dar 400 | datas com fuso |
| ATT-13 | WHEN chega toque de dispositivo com cadastro já feito THEN SHALL dar 409 (a decisão é imutável) | consistência |

## Critérios de aceite
Cada ID acima tem ao menos um teste em `test/` (ver tabela no README).
