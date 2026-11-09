# Ferramentas de design: implementação e avaliação

Estado desta primeira rodada. O modo estrito e a verificação nativa foram concluídos na [rodada seguinte](design-strict-consistency-results.md).

Implementação em 2026-11-01, sem commit, publicação ou build nativo. A [auditoria inicial](design-agent-consistency-audit.md) registra os problemas anteriores.

## Entregue

1. Contraste normalizado para todas as cores aceitas pelo schema, compartilhado com o SVG. Diagnósticos distinguem contraste avaliado de transparência/backdrop não suportado. O limiar existente de 3:1 foi mantido.
2. `design_inspect` retorna imagem, recorte de camada, versão, dimensões e diagnósticos sem salvar. `design_validate` verifica documento ou operações sem escrita, com caminhos dos campos. Erros de edição são curtos.
3. `design_kit_read/save` armazenam kits por Project, com histórico imutável, isolamento entre Projects e controle de versão. Cores, tipografia, espaçamento, raios, componentes e referências ficam no snapshot fixado por cada tela. Atualização é explícita; desktop e mobile mostram o kit e sua versão. Exportação pública remove metadados privados. Divergências são avisos, não bloqueios.
4. Componentes têm propriedades tipadas de texto, ícone, visibilidade, cor e opacidade, com opções permitidas. Instâncias preservam valores próprios durante alterações na origem. Operações `document`, `duplicate`, `detach` e `unset` evitam reenviar a tela inteira. Edições locais de propriedades removem só o vínculo correspondente ao kit e sobrevivem ao salvamento. Templates do kit são copiados; atualizar o kit não substitui automaticamente componentes já copiados. Componentes aninhados continuam fora do escopo.
5. Harness real para Codex e Claude, criação/revisão/visão/troca de modelo, comparação exata de documentos, conflito de versão e registro de tempo, tokens, diagnósticos e imagens. Execução opt-in: `node scripts/eval-design-models.cjs --live --runs 2 --output /tmp/milagre-design-eval`. Usa os logins existentes. Se o Claude do terminal estiver desconectado, selecionar o perfil já conectado do Project com `CLAUDE_CONFIG_DIR`; não copiar credenciais.

## Eval real, iniciado depois das 20h

Modelos selecionados da lista real dos provedores: `gpt-6.1-sol` e `claude-opus-5-5`, esforço `low`, duas repetições por modelo. Codex CLI 0.166.0; Claude Code 2.1.316. Mesmos brief, kit e skill. SHA-256 da skill durante o eval: `4cf9e60762a48579da1e33383eb7da2aa9fe21428b236939e804dfffb8609bfe`. A skill recebeu depois a explicação sobre desvincular uma propriedade ao editá-la localmente.

O SDK Claude também reportou uso auxiliar de `claude-haiku-5-5`; o relatório preserva esses nomes. Tokens/cache dos provedores têm contabilidade distinta e não devem ser comparados como custo equivalente.

| Amostra  | Criação | Escritas até concluir criação | Divergências do kit na execução | Divergências após correção do verificador | Contrato |
| -------- | ------: | ----------------------------: | ------------------------------: | ----------------------------------------: | -------- |
| GPT 1    |  39,0 s |                             1 |                               7 |                                         7 | Passou   |
| GPT 2    |  32,1 s |                             2 |                               0 |                                         0 | Passou   |
| Claude 1 |  30,9 s |                             2 |                              10 |                                        19 | Passou   |
| Claude 2 |  33,5 s |                             2 |                              11 |                                        21 | Passou   |

As quatro amostras fixaram o kit, criaram botões vinculados com textos distintos, reconheceram um círculo vermelho apenas pela imagem, inspecionaram sem nova versão, preservaram a edição manual e todos os campos não solicitados durante revisão e troca de modelo. Escritas com versão antiga foram recusadas. As quatro imagens de criação foram inspecionadas visualmente; não havia corte ou sobreposição visível nem aviso de contraste/layout na criação.

**Contrato aprovado não equivale a identidade visual estrita.** Três das quatro criações usaram estilos fora do kit. O eval expôs que cores extras com nomes de tokens escapavam do verificador. Isso foi corrigido, e os mesmos documentos foram reavaliados localmente. As contagens posteriores não são uma nova rodada com modelos. Ainda falta um modo de adesão obrigatória ou aprovação explícita das exceções para garantir identidade estrita. Esta amostra pequena não é um ranking de modelos.

Na troca de modelo, o prompt mandava alterar somente o texto para uma frase maior. Houve corte do título nas duas telas GPT; Claude informou o corte sem mudar campos proibidos. Nas duas telas Claude, a mesma frase coube sem corte; GPT preservou os campos ao assumir essas telas. A reavaliação local dos quatro documentos confirmou essa diferença de layout. Esse caso distingue preservação do documento de qualidade visual e permanece um alvo para o próximo eval.

Resumo estruturado preservado no repositório: [resultados JSON](evals/design-consistency-2026-11-01.json). Resultados brutos locais: `/tmp/milagre-design-eval-final/results.json`; imagens e documentos na mesma pasta. O agendamento de 20h foi removido depois da execução para evitar consumo duplicado.

## QA e correções

Duas personas, `qa-literal` e `qa-breaker`, usaram instâncias descartáveis e o contrato/documentação público. Ambas chegaram à primeira criação. A primeira rodada encontrou três problemas; a segunda confirmou as três correções, sem novos achados:

| Problema                                  | Persona | Correção                                | Evidência posterior                                                 |
| ----------------------------------------- | ------- | --------------------------------------- | ------------------------------------------------------------------- |
| Recorte de camada falhava no rasterizador | Literal | Recortar o raster do documento completo | `.qa-fleet/2026-11-01-2005/run2/qa-literal/16-design_inspect-0.png` |
| Erro sem caminho do campo                 | Breaker | Propagar caminho em erros semânticos    | `run2/qa-breaker/07-missing-style-validate.txt`                     |
| Validação devolvia erro bruto extenso     | Breaker | Compactar erro e apontar campo          | `run2/qa-breaker/20-invalid-color-apply.txt`                        |

Também foram corrigidos o retorno silencioso de valores numéricos editados para o valor do kit e a prioridade dos diagnósticos: avisos de identidade não escondem corte/contraste na resposta textual limitada.

## Verificação e pendências

- Typecheck desktop/mobile e lint passaram. Os 224 testes focados de design/integração passaram; Electron `design-editor` passou em 24,0 s. Os 456 testes do harness mobile passaram; não substituem um dispositivo nativo.
- Suíte completa: 6.805 passaram, 12 ignorados e uma falha no teste existente de encerramento de processos por timeout (`worktree-setup.test.cjs:109`). O teste passou isoladamente junto de outros 47; falhou sob a carga da suíte. Não foi alterado para mascarar essa instabilidade.
- Desktop: screenshot real do Electron de teste inspecionado, com nome e versão do kit no editor. Evidências em `/tmp/milagre-design-consistency-shots`. São imagens de fixture, não imagens para PR.
- iOS nativo: pendente. Fingerprint atual `a6cfd793a41a6101f3b11ae68ac55ddad986fbe4`, igual ao runtime do TestFlight build 38 (0.1.1). Portanto, as alterações são compatíveis com OTA. Nenhum cliente de desenvolvimento disponível para simulador tinha esse fingerprint. A skill de teste mobile exige aprovação para um build nativo novo, solicitada ao usuário; não houve build, prebuild, EAS ou publicação. O harness mobile não substitui essa verificação.
