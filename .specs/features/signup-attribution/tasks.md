# Tarefas: signup-attribution

Status: Concluído

| ID | Tarefa | Depende de | Verificação | Feito |
| --- | --- | --- | --- | --- |
| T1 | Esqueleto (package, tsconfig, vitest) | | `npm run typecheck` | [x] |
| T2 | Spec e tasks em `.specs/` | | revisão | [x] |
| T3 | `time.ts` + `link.ts` (parse puro) com testes primeiro | T1 | `test/parse.test.ts` | [x] |
| T4 | `attribution.ts` (decisão pura) com testes primeiro | T3 | `test/attribution.test.ts` | [x] |
| T5 | `db.ts` (tabelas e acesso) | T4 | coberto pelos testes de API | [x] |
| T6 | `app.ts` + testes de API primeiro | T5 | `test/api.test.ts` | [x] |
| T7 | `index.ts`, `.env.example` | T6 | subida real + curl | [x] |
| T8 | README | T7 | exemplos rodados com curl | [x] |
| T10 | Ajuste do autor: toque tardio aceito e auditado (ATT-13/14), testes primeiro | T6 | `test/api.test.ts` bloco "toques recebidos depois do cadastro" | [x] |
| T9 | Mutações de verificação | T6 | teste falha, desfeito | [x] |
