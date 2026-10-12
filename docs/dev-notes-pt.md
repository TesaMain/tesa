# Tesa — notas de desenvolvimento (M1 + M2)

> Notas técnicas em português. Para a visão geral em inglês, veja o [README](../README.md).
> Referências a "seção N" são da especificação interna do MVP, que não está publicada.

Software de tesouraria B2B, non-custodial: o caixa em USDC do cliente rende em USDY
dentro de um multisig Squads, com regras de tesouraria aplicadas on-chain.

Este repositório está no **marco M2**: programa Anchor `tesa_policy`, swap simulado
(`mock_swap`) e um multisig Squads v4 de teste executando as operações via vault transaction,
tudo na localnet.

## Estrutura

```
programs/tesa_policy/   política: initialize/update/set_paused/begin_op/end_op/cancel_op + preço de referência
programs/mock_swap/     USDY simulado + swap a preço e slippage configuráveis (só localnet/devnet)
tests/tesa_policy.ts    M1: cada verificação da seção 3.4, com casos de sucesso e de falha (vault = Keypair)
tests/squads.ts         M2: mesmo fluxo com o vault PDA de um multisig Squads v4 (seção 3.1)
tests/utils.ts          ajuste do cache de blockhash para o Surfpool
tests/fixtures/         programa Squads v4 e sua ProgramConfig, copiados da mainnet
```

## Rodar

Versões validadas em 11/10/2026 (ver "Verificações" abaixo):

| Ferramenta | Versão |
|---|---|
| Rust | stable ≥ 1.89 (MSRV do Anchor 1.2.1) |
| Solana CLI (Agave) | 4.1.x |
| Anchor CLI | 1.2.1 (via `avm`) |
| Node | LTS + yarn |
| Surfpool | validador local padrão do `anchor test` no Anchor 1.x |

```bash
yarn install
anchor keys sync        # gera os program IDs reais e atualiza declare_id!/Anchor.toml
anchor build
anchor test             # Surfpool (~3s); ou: anchor test --validator legacy (~35s)
cargo test -p tesa_policy   # testes unitários da matemática
```

O programa Squads v4 e a conta `ProgramConfig` (exigida pelo `multisig_create_v2`) entram na
localnet por `[[test.genesis]]` e `[[test.validator.account]]` no `Anchor.toml`, a partir de
`tests/fixtures/`. Para atualizar:

```bash
solana program dump -u m SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf tests/fixtures/squads_v4.so
solana account -u m BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr --output json -o tests/fixtures/squads_program_config.json
```

**Surfpool e blockhash.** O `anchor test` sobe o Surfpool em `--block-production-mode transaction`,
que avança ~31 blocos por transação. O web3.js guarda o blockhash em cache por 30s, então
depois de ~5 transações ele usa um blockhash vencido e falha com `Blockhash not found`. Por isso
os testes desligam o cache quando o validador é o Surfpool (`tests/utils.ts`); no
`solana-test-validator` o cache fica ligado. Não use `[surfpool] block_production_mode = "clock"`
como alternativa: nesse modo o Surfpool 1.6.1 às vezes não envia a notificação de
`signatureSubscribe`, e o `confirmTransaction` espera até o blockhash expirar (~40s) mesmo com a
transação já finalizada. Os testes também usam uma conexão em `confirmed`: os helpers do
`spl-token` confirmam no commitment da conexão e, em `processed`, corriam contra a simulação
`confirmed` da transação seguinte.

## Instruções

| Instrução | Signer | Função |
|---|---|---|
| `initialize_policy` | vault | Cria `Policy` e `Position` |
| `update_policy` | vault | Altera limites e a conta de preço |
| `set_paused` | vault | Emergência |
| `begin_op` | vault | Checa pausa, preço fresco, teto por operação e saldo; fotografa saldos em `OpReceipt` |
| `end_op` | vault | Verificações 1–5, atualiza `Position`, emite `OpExecuted`, fecha `OpReceipt` |
| `cancel_op` | vault | Fecha um `OpReceipt` órfão (begin sem end) |
| `init_price_feed` / `set_price` | chave de preço da Tesa | Preço de referência (NAV do USDY) |

### Verificações de `end_op`, na ordem em que rodam

| # | Regra | Erro |
|---|---|---|
| 5 | Saída do cofre == `amount_in` (nada além disso saiu) | `AmountInMismatch` / `UnexpectedBalanceChange` |
| 1 | Recebido ≥ `min_out` | `BelowMinOut` |
| 2 | Valor recebido ≥ valor justo × (1 − `max_slippage_bps`) | `SlippageExceeded` |
| 3 | Só em alocação: valor em USDY / caixa total ≤ `max_yield_bps` | `YieldCapExceeded` |
| 4 | Só em alocação: USDC ≥ `min_liquid_usdc` | `BelowMinLiquidity` |

Qualquer falha reverte a transação inteira, inclusive o swap (os testes conferem saldos,
nonce e posição inalterados após cada falha).

## Decisões tomadas no M1 (desvios ou detalhes além da especificação)

1. **Verificações 3 e 4 só valem para alocação.** Um resgate sempre reduz a exposição e
   aumenta o USDC; bloqueá-lo porque o cofre já está fora da política (ex.: o NAV subiu)
   impediria justamente a correção. Há teste cobrindo isso.
2. **Slippage só conta no sentido adverso.** Receber mais que o preço de referência não falha.
3. **Saldos são medidos nas ATAs canônicas do vault.** As duas ATAs (USDC e USDY) precisam
   existir **antes** do `begin_op`. Consequência para o M3: as `setupInstructions` da Jupiter
   (criação idempotente de ATA) devem ir **antes** do `begin_op`, ou as ATAs devem ser criadas
   no onboarding. Ordem sugerida: `compute budget → setup Jupiter → begin_op → swap → end_op`.
4. **`cancel_op` foi adicionada.** Sem introspecção, o programa não garante que `begin_op` e
   `end_op` estão na mesma transação; um `begin_op` isolado deixaria o recibo do nonce atual
   aberto e travaria a política.
5. **Preço de referência = conta `PriceFeed` mantida pela Tesa** (alternativa 2 da seção 3.6),
   com preço em USD × 1e9 e `publish_ts` monotônico. Motivo: ver verificação da Pyth abaixo.
6. **O vault paga o aluguel do `OpReceipt`** e recebe de volta no `end_op`. O vault PDA da
   Squads tem SOL e assina via CPI, então funciona sem um pagador extra.
7. **Eventos via `emit!` (logs).** No M2, sob a Squads, o `end_op` roda em CPI; avaliar
   `emit_cpi!` se o indexador da Helius tiver problema com logs truncados.

## M2 — integração Squads

`tests/squads.ts` cria um multisig Squads v4 com as permissões da seção 3.1 (CFO e Controller com
Initiate/Vote/Execute, chave da Tesa só com Initiate, threshold 2) e roda o fluxo da seção 4: a
chave da Tesa cria a vault transaction e a proposta numa única transação, CFO e Controller aprovam,
e um deles executa. O vault PDA (índice 0) é o `vault` da política: paga o aluguel de `Policy`,
`Position` e `OpReceipt` e assina via CPI da Squads.

| Teste | O que mostra |
|---|---|
| Permissões | Threshold 2; a chave da Tesa não tem Vote nem Execute |
| `initialize_policy` via vault transaction | A política fica presa ao vault PDA |
| Chave da Tesa | Propõe, mas `proposal_approve` e `vault_transaction_execute` falham com `Unauthorized` |
| 1 de 2 | Não executa (`InvalidProposalStatus`); uma rejeição já deixa a proposta `Rejected` |
| Alocação | `begin_op → swap → end_op` executa; saldos, `Position` e evento `OpExecuted` conferidos |
| Acima do teto | Proposta aprovada, execução falha on-chain (`ExceedsMaxOp`), nada muda |
| Cotação piora após aprovação | O swap roda e o `end_op` reverte tudo (`SlippageExceeded`) |
| Resgate | Realiza o resultado pelo custo médio |
| Nonce desatualizado | De duas propostas montadas com o mesmo `op_nonce`, só a primeira executa |

### Decisões e achados do M2

1. **O compute budget fica na transação externa**, junto do `vault_transaction_execute`, e não
   dentro da vault transaction: instruções de compute budget só valem no nível superior da
   transação. A ordem da seção 3.5 vale para o conteúdo da vault transaction, sem o compute budget.
2. **A chave da Tesa não consegue cancelar propostas.** Na Squads, cancelar exige o voto de
   membros com Vote até o threshold. "O backend cancela a proposta" (seção 4) não é possível só
   com Initiate: ou os humanos cancelam (2 votos), ou a proposta antiga é abandonada.
3. **Abandonar é seguro por causa do `op_nonce`.** Cada proposta de operação aponta para o
   `OpReceipt` do nonce em que foi montada. Quando uma operação executa, o nonce avança e qualquer
   outra proposta montada com o nonce antigo passa a falhar (`ConstraintSeeds`). Consequência:
   propostas de operação concorrentes são mutuamente exclusivas, e o backend deve montar a
   próxima só depois que a anterior executar ou for descartada.
4. **O evento `OpExecuted` continua legível** nos logs da execução, mesmo emitido dentro da CPI
   da Squads (o `EventParser` do Anchor acompanha a pilha de invocações). `emit_cpi!` só será
   necessário se o indexador da Helius tiver problema com logs truncados (M4).
5. **Tamanhos com o swap simulado:** criar vault transaction + proposta ocupa 934 de 1232 bytes;
   a execução ocupa 812 bytes com 21 contas. Uma rota real da Jupiter não cabe nisso: o M3 vai
   precisar do transaction buffer da Squads e de ALTs, como previsto.

### Devnet (12/10/2026)

Os 9 testes de `tests/squads.ts` passam na devnet contra a Squads v4 oficial (mesmo program ID e
`ProgramConfig` da mainnet). Programas publicados com a carteira local como upgrade authority
(`77HwH76xd3bbJqAzeM9v9rEAYvJQLmi8coAWJo1xCejk`):

| Programa | ID |
|---|---|
| `tesa_policy` | `9oTWN6zV7bZfdqtSNRXJ92tSmuGJLqaetsGTQkC2L8wB` |
| `mock_swap` | `2khHAreRkYwwB2RTEJMzcsfsYdV9N1Pepp3Win8sxKUB` |

```bash
solana program deploy target/deploy/tesa_policy.so --program-id target/deploy/tesa_policy-keypair.json -u d
solana program deploy target/deploy/mock_swap.so --program-id target/deploy/mock_swap-keypair.json -u d
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/squads.ts
```

Custos: ~2,3 SOL de aluguel dos dois programas; ~0,25 SOL por execução da suíte. Cada execução
cria um multisig novo. Na primeira:

- Multisig: [`KYb8yGsJ…W27m`](https://solscan.io/account/KYb8yGsJRAoD2DWpWDgKxz53sdYzBvQXYjMvo1DW27m?cluster=devnet),
  vault [`5xSeBbac…K1SG`](https://solscan.io/account/5xSeBbactChSrzwkxPkgM4CAC7SQjM7d4VUtAiX9K1SG?cluster=devnet)
- `initialize_policy` executado pelo vault: [`2CPKk1Gs…`](https://solscan.io/tx/2CPKk1GsLpoDpyKTmJrCa9ZyaZugGG99vrHE6rAF7UBdiLh92vi7pKvXuqxgm3Z1unAoGjWGQwoAjQT9PbCk6Hug?cluster=devnet)
- Alocação de 20.000 USDC simulados (`begin_op → swap → end_op`): [`56pkRrah…`](https://solscan.io/tx/56pkRrahcq3XDuhrUneZ1a9F1sY9mmMVxbGicjE8WHdQMBL3hVR8yfh7LaL1drprmYyraAqcVKEXbmeKgtgjRMYm?cluster=devnet)
- Resgate: [`fBv4PDib…`](https://solscan.io/tx/fBv4PDib9ASBMK2zGbzoJtRj3zQiqbLatDu3Eu2rDXgYFnxUbNovvVR4CEDWYR5F2NuVXfKUr1ksEr688xSA3Es?cluster=devnet)

**Testnet:** os mesmos dois programas, com os mesmos IDs, também estão publicados na testnet
(12/10/2026), e os 9 testes de `tests/squads.ts` passam lá (troque `-u d` por `-u t` e a URL da RPC).

**Falhas não ficam on-chain por padrão.** As execuções rejeitadas (acima do teto, slippage, nonce
velho) param na simulação de preflight do web3.js e nunca são enviadas. Para a demo da seção 7.2
("falha on-chain, ao vivo", com link no Solscan), a execução tem de ir com `skipPreflight: true`:
a transação entra num bloco, falha com `ExceedsMaxOp` e paga só a taxa.

## Painel de demo (testnet)

`app/` é o painel para os jurados: um site estático (Vite + React) que lê e assina direto na
testnet, sem backend. Mostra o cofre (valor, USDC, USDY, rendimento pela fórmula da seção 7.3),
as regras da política, as propostas da Squads com os botões de cada papel, o histórico on-chain e
um log das transações da sessão com o tempo de liquidação. Um roteiro de 8 passos guia a
apresentação (seção 7, sem a mainnet).

**CCTP real (devnet).** A demo foi para a devnet porque o CCTP da Circle só liga Sepolia à
**devnet** da Solana. "Bridge from Ethereum" faz burn real no Sepolia, espera a atestação da Circle
e chama `receiveMessage` na Solana, cunhando USDC de teste da Circle direto na conta do cofre
(`app/src/cctp.ts`; contas conforme `examples/v2/solana.ts` do repositório oficial, mais as contas
`#[event_cpi]` do MessageTransmitterV2). Simulados: USDY e o swap (não existem em redes de teste). O card "Fintech customers" divide valor e rendimento do cofre entre 3 clientes de
exemplo com participação fixa (40/35/25%), com 10% do rendimento como taxa da fintech. É um
cálculo no painel a partir dos dados on-chain; sub-contas on-chain por cliente ficam no roadmap.

**Chaves de demo no site.** As chaves de Tesa, CFO, Controller e do operador da demo ficam em
`app/src/demo-config.json` e vão junto no JavaScript publicado: qualquer pessoa com o link opera o
cofre. É uma escolha da demo (só SOL e tokens simulados da testnet). O operador simula o mundo
externo (NAV da Ondo, mercado, depósitos) e não tem como tirar nada do cofre.

**Falhas aparecem on-chain.** O painel envia tudo com `skipPreflight`: uma execução que a
política rejeita entra num bloco e falha com o código do erro, com link no Solscan.

**Preço velho.** Antes de executar uma operação, se o NAV estiver a menos de 5 min de vencer
(`max_price_age_secs` = 1 h), o painel republica o NAV pelo operador, como o cron da seção 5.

```bash
cd app
yarn install
# cria um cofre novo na testnet (~0,7 SOL da carteira local) e grava src/demo-config.json
RPC_URL=https://api.testnet.solana.com CLUSTER=testnet npx tsx scripts/setup-demo.ts
yarn dev          # local
yarn build        # gera dist/ para publicar (Netlify: arrastar a pasta dist em app.netlify.com/drop)
```

**Dentro do site t3sa.com (demo.t3sa.com).** O painel também é empacotado dentro do site, na
pasta `demo/`, com `BASE=/demo/ yarn vite build --outDir dist-demo`. O `netlify.toml` do site
reescreve `https://demo.t3sa.com/*` para `/demo/:splat` (a URL continua demo.t3sa.com), e
`demo.t3sa.com` entra como domain alias do site no Netlify, como o `docs.t3sa.com`. O painel
também responde em `t3sa.com/demo/`. A página tem `noindex`.

Para "zerar" a demo antes de uma apresentação, rode o setup de novo e publique o novo build: cada
execução cria um multisig e um cofre novos (100.000 USDC, 30.000 já alocados a NAV 1,12 e NAV
atual 1,141). Cofre atual (recriado em 12/10/2026 para a apresentação): multisig
[`9CXMYDZm…yqbG`](https://solscan.io/account/9CXMYDZmXNSZmabAwWXCezvUWMuiAmbp1g4KHKRwyqbG?cluster=testnet),
vault [`DbEGxMV1…xne`](https://solscan.io/account/DbEGxMV1qW6to3rxu7TmRUVz2yD5G5dxSehaPpMCyxne?cluster=testnet).

## Verificações da seção 8 (11/10/2026)

| Ponto | Resultado |
|---|---|
| USDY: SPL Token ou Token-2022? | **SPL Token clássico** (`owner = Tokenkeg…`), 6 decimais, freeze authority `51QVCuHf…shiuK`, mint authority `8n2uiRUd…qkB1`. Consultado via `getAccountInfo` na mainnet. Sem extensões, sem impacto na profundidade de CPI. |
| Feed Pyth USDY/USD na mainnet? | Existem os IDs `Crypto.USDY/USD` (`e393449f…7326`) e `Crypto.USDY/USD.RR` (taxa de resgate/NAV, `e3d17239…d500`). A conta push do USDY/USD na Solana (`9VxAH1Gn…HAG2`) existe, mas o último update tinha **~55 dias** (preço 1,1413). A do `.RR` não existe. **Conclusão:** não há feed patrocinado ativo; usamos a conta de preço da Tesa. Alternativa futura: postar um update pull (Pyth receiver) do `.RR` antes da execução. |
| SDK `@sqds/multisig` | `2.1.4` (latest no npm). Program ID v4 `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`. O SDK tem `transactionBufferCreate/Extend/Close` e `vaultTransactionCreateFromBuffer`, além de `Permission.Initiate/Vote/Execute`. Depende de `@solana/web3.js` 1.x. |
| API de swap da Jupiter | `/swap/v1/quote` + `/swap/v1/swap-instructions` (Metis) estão **sem manutenção**. A substituta é **`GET https://api.jup.ag/swap/v2/build`**, que junta cotação e instruções (`taker` no lugar de `userPublicKey`, `maxAccounts` 1–64, só ExactIn, ALTs em `addressesByLookupTableAddress`). Exige `x-api-key`. As instruções V2 não emitem eventos, o que é compatível com o nosso desenho de checar saldos. |
| Versões compatíveis | Anchor **1.2.1** (5/10/2026): Rust MSRV 1.89, crates Solana v3 por padrão (`solana-v4` opcional), `solana-program` 4.1.0, docs usam `solana-cli 4.1.2`. Agave mais recente: 4.3.0 (a mainnet roda 4.3.0). O pacote npm agora é `@anchor-lang/core` (não `@coral-xyz/anchor`). `anchor test` usa Surfpool por padrão. Mudança de API: `CpiContext::new(program_id: Pubkey, …)`. |

## Riscos a declarar

- **USDY congelável pela Ondo** (freeze authority confirmada on-chain): risco do emissor.
- **Termos da Ondo proíbem US persons:** o onboarding precisa coletar isso.
- **Autoridade de upgrade do programa:** no MVP fica documentada; em produção, multisig com
  timelock ou programa imutável.
- **Preço de referência mantido pela Tesa** é um ponto de confiança: uma chave da Tesa
  publica o NAV. Mitigações: `max_price_age_secs`, `publish_ts` monotônico, e a política
  aponta para uma conta específica que só o vault pode trocar.
- **Programa não auditado:** na mainnet, só valores mínimos.
- **Liquidez rasa do USDY (Orca, ~US$2,9M):** a checagem de slippage contra o NAV protege
  o cliente, mas pode fazer operações maiores falharem.
