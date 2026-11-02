# Consistência estrita: regras e verificação

Concluído em 2026-11-01, depois da primeira [rodada de melhorias](design-agent-consistency-results.md). Validação concluída antes da abertura do PR. Nenhum EAS, TestFlight ou OTA publicado.

## Regras implementadas

- A composição continua livre: conteúdo, hierarquia, posições e dimensões podem variar. Cores efetivas, tipografia completa, padding/gap e raios seguem os valores do kit. Transparência e zero são permitidos. Dimensões mínimas só entram na escala de espaçamento quando vinculadas a um token.
- `document.consistency.mode` aceita `advisory` (padrão) e `strict`. O modo estrito exige kit fixado e escalas não vazias. Bloqueia preflight e salvamento com divergências, incluindo cores padrão e cores expostas por instâncias. A verificação compartilhada é usada por agentes e pelo salvamento do editor. Documentos sem kit continuam funcionando no modo padrão.
- Exceções explícitas têm `nodeId`, `field`, `value` e `reason`. O valor precisa corresponder exatamente ao diagnóstico atual; uma mudança posterior de cor invalida a exceção anterior. A exceção continua visível como `kit-exception`. É registro de intenção, não uma certificação independente de autorização. Referências e motivos privados são omitidos das páginas públicas.
- Uma substituição completa que omite `consistency` mantém a política anterior. Alterar para advisory exige declarar o novo modo. Leitura e renderização de rascunhos continuam possíveis; uma recusa não grava versão nem descarta o rascunho. Componentes mantêm os vínculos locais e opções tipadas existentes. O modo não exige que toda camada seja uma instância de um template do kit.
- As instruções distinguem "só o texto" de "acomodar o texto". No primeiro caso, outros campos ficam intactos e problemas visuais são reportados. No segundo, geometria pode mudar, preservando conteúdo, identidade e edições humanas. Corte e overflow continuam sendo diagnósticos separados do modo estrito.

Para ativar em uma tela existente, ler a versão atual e enviar `design_apply` com uma operação `document` cuja propriedade `consistency` seja `{mode: "strict"}`. Usar `design_validate` antes permite corrigir divergências sem salvar. Desktop e mobile exibem "Strict" antes do nome do kit para que um nome longo não esconda o modo.

## Eval real

Comando: `node scripts/eval-design-models.cjs --live --strict --runs 2 --output /tmp/milagre-design-eval-strict-final`. Modelos `gpt-6.1-sol` e `claude-opus-5-5`, esforço low, mesmos brief e kit. Perfis já conectados; nenhuma credencial copiada. Configuração, uso de tokens, respostas e diagnósticos estão no [JSON de resultados](evals/design-strict-2026-11-01.json).

| Amostra  | Criação | Escritas na criação | Divergências do kit | Resultado |
| -------- | ------: | ------------------: | ------------------: | --------- |
| GPT 1    |  30,1 s |                   1 |                   0 | Passou    |
| GPT 2    |  31,5 s |                   1 |                   0 | Passou    |
| Claude 1 |  21,9 s |                   2 |                   0 | Passou    |
| Claude 2 |  34,5 s |                   3 |                   0 | Passou    |

As quatro amostras passaram criação, visão sem ler o JSON, revisão exata, conflito de versão, alteração apenas do texto, acomodação do texto e troca de modelo. As imagens de criação não tiveram avisos de layout/contraste. As quatro imagens finais foram inspecionadas: títulos legíveis, botões visíveis, sem sobreposição entre título e subtítulo.

Na primeira amostra GPT, o título longo empurrou os botões para fora do espaço disponível. O modelo reportou o problema durante a alteração só de texto e, quando autorizado a ajustar o layout, mudou somente alturas de espaçador/container. Nas outras três amostras o título já cabia graças ao Hug. O harness compara os documentos para impedir mudanças não solicitadas; no ajuste de layout aceita apenas geometria e verifica diagnósticos mais os limites de título/subtítulo.

A única exceção restante foi o círculo vermelho inserido pelo próprio teste, com motivo explícito, usado para confirmar que ambos recebiam e reconheciam a imagem. As criações não usaram exceções. Em comparação com a primeira rodada, divergências passaram de três telas em quatro para zero em quatro. A amostra é pequena e o brief também passou a pedir strict e Hug; não é um ranking estatístico nem uma atribuição causal isolada.

## Desktop e iOS

Desktop Electron: salvar uma cor fora da paleta falha com o campo e a correção; a versão permanece e o rascunho continua editável. Corrigir a cor permite salvar. Teste automatizado passou, incluindo revisão de conflitos, componentes, exportação e rascunhos. Imagens em `/tmp/milagre-strict-desktop/`.

iPhone 17e, iOS 27.0, simulador `6A13C3C2-3621-4EDE-81C7-511A174BEF45`, adquirido via simshare e verificado slim. Build Debug local autorizado pelo usuário, host descartável e Metro deste Worktree na porta 8894. Verificado:

1. Tela com kit v1 e indicador Strict visível.
2. Versão 1 mostra "A little less rush."; versão 2 mostra "A little more outside.". A instância conserva "Tomorrow's walk" nas duas.
3. Escolher versão 2 e enviar a escolha retorna ao Chat com "Chose Fieldnotes", v2, e resposta da fixture.
4. Uma tentativa inicial da fixture com raio fora do kit foi recusada e o erro apareceu no Chat. A fixture foi corrigida com a escala prevista e recriada.

Imagens reais do simulador em `/tmp/milagre-strict-ios/`, incluindo `chosen.png`, `version-menu.png` e `feedback-sent.png`. São evidências de teste com provedor simulado; os modelos reais foram verificados no harness separado. Não são screenshots para PR. Android não foi executado.

O primeiro build encontrou o crash Swift 6.4.2 em ExpoModulesCore. Foi aplicada temporariamente em node_modules a [correção oficial Expo #52631](https://github.com/expo/expo/pull/52631), retirando um cast redundante. A compilação e instalação concluíram; o lançamento automático do Expo na porta 8081 falhou, então o app foi aberto explicitamente apontando para o Metro 8894. O arquivo original da dependência foi restaurado e conferido byte a byte. O build local de teste contém esse contorno; nenhuma alteração nativa entrou no repositório. O fingerprint antes/depois permaneceu `a6cfd793a41a6101f3b11ae68ac55ddad986fbe4`, correspondente ao runtime já verificado do TestFlight. O build ficou disponível no cache simshare.

## Checks

- Typecheck desktop e mobile, lint e contratos gerados: passaram.
- 221 testes focados após as últimas correções: passaram.
- Harness mobile: 456 passaram.
- Electron design-editor: passou em 27,5 s, incluindo recusa estrita e recuperação do rascunho.
- Suíte completa após as últimas correções: 6.811 passaram, 12 ignorados, zero falhas em 151,1 s (629 arquivos).

Limites: strict garante apenas as regras declaradas do kit, não qualidade estética, acessibilidade completa ou ausência de qualquer sobreposição possível. Exceções e a troca explícita de modo continuam disponíveis para decisões intencionais do usuário.
