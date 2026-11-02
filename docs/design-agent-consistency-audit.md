# Consistência das ferramentas de design entre agentes

Auditoria inicial de código em 2026-11-01. Os achados abaixo descrevem o estado anterior à implementação. Resultado da implementação e eval: [relatório de verificação](design-agent-consistency-results.md).

Escopo: contrato MCP, instruções, documento, componentes, feedback visual, desktop/mobile e verificação com provedores.

## Resultado pretendido

Claude, GPT e outros modelos devem receber a mesma identidade visual do Project, os mesmos componentes e critérios de qualidade. Ao assumir um design existente, devem conseguir inspecionar o resultado atual e preservar as decisões do usuário. Composições podem variar; tokens, comportamento dos componentes e proteção das edições devem ser previsíveis.

A base já existe: formato compartilhado, renderização centralizada, ids estáveis, edições atômicas e proteção por `expectedVersion`. As instruções também são compartilhadas. Falta transformar parte das recomendações visuais em dados reutilizáveis e verificáveis.

## Achados e prioridades

### 1. P1: a avaliação de contraste depende da escrita da cor

**Reproduzido.** Texto branco sobre fundo `#ffffff`, com dimensões suficientes para não cortar texto:

| Cor do texto       | Resultado de `designWarnings` |
| ------------------ | ----------------------------- |
| `#ffffff`          | `low-contrast`, 1.0:1         |
| `white`            | Nenhum aviso                  |
| `hsl(0, 0%, 100%)` | Nenhum aviso                  |
| `#ffffffff`        | Nenhum aviso                  |

O schema aceita essas representações, mas o cálculo reconhece apenas alguns formatos. Os testes atuais documentam a decisão de ignorar cores não reconhecidas. Isso produz feedback diferente para resultados visualmente iguais, inclusive texto invisível.

**Proposta:** normalizar as cores aceitas antes do cálculo, compartilhar essa normalização com os renderizadores e distinguir `checked`, `unsupported` e `failed`. Ausência de avisos não deve significar que todos os itens foram avaliados. Manter categorias informativas, como imagem remota, separadas dos defeitos corrigíveis.

**Aceite:** representações equivalentes recebem a mesma razão e o mesmo diagnóstico; avaliação indisponível aparece explicitamente. O limite atual de 3:1 para qualquer tamanho é uma decisão separada que merece revisão, não um erro novo introduzido nesta tarefa.

Fontes: `packages/shared/src/design-lint.mjs:36`, `packages/shared/src/design-lint.test.mjs`, `packages/shared/src/design.mjs:34`.

### 2. P1: falta inspecionar um design salvo sem criar versão

**Confirmado por leitura do contrato.** `design_read` devolve JSON, sem imagem nem nova avaliação de layout. `design_show` e `design_apply` devolvem imagem e avisos depois de salvar. Não há operação dedicada para obter esse feedback de uma versão existente sem uma escrita. Exportar SVG é uma alternativa indireta, que exige outro passo para visualizar.

Isso afeta troca de modelo, retomada após compactação e revisão de alterações feitas pelo usuário. Além disso, a imagem do agente usa placeholders para imagens remotas e Inter para fontes não incluídas; portanto, ela não é sempre a mesma imagem vista no desktop ou celular.

**Proposta:** `design_inspect(id, version?, nodeId?)`, somente leitura, com imagem, dimensões calculadas, diagnósticos e limitações da prévia. Permitir recorte de camada para inspecionar detalhes. Retornar versão e condições da renderização para o agente saber o que viu. Para imagens externas, usar recursos resolvidos e armazenados com controles de rede, sem buscar URLs arbitrárias sem limites.

**Aceite:** inspecionar não cria versão; dois modelos inspecionando a mesma versão recebem o mesmo conteúdo visual sob as mesmas condições; substituições ficam explícitas.

Fontes: `packages/core/src/chat-artifacts.cjs:782`, `packages/core/src/chat-artifacts.cjs:842`, `packages/core/src/design-raster.cjs`, `packages/core/src/design-raster-worker.cjs`.

### 3. P1: identidade visual pertence à tela, não ao Project

**Limitação confirmada no formato.** `tokens` contém apenas cores dentro de um documento. Tipografia, espaçamento e raios são números locais. Componentes referenciam ids do mesmo documento. `group` organiza o canvas, mas não estabelece uma identidade visual compartilhada. A skill manda ler o estilo do app; essa descoberta depende de cada modelo.

**Proposta:** kit visual versionado por Project, com cores semânticas, estilos de texto, espaçamento, raios, componentes e referências aprovadas. Cada documento referencia uma versão do kit. A ferramenta fornece esse contexto na criação e na retomada, e aponta divergências. Uma atualização do kit apresenta impacto antes de migrar telas existentes; não deve reestilizar designs aprovados silenciosamente.

**Aceite:** uma nova tela em outro Chat pode reutilizar o mesmo kit; trocar de modelo preserva a referência; desktop e mobile mostram a mesma versão e os mesmos avisos. Extrair sugestões do código pode ajudar, mas a origem e as escolhas confirmadas precisam ficar registradas.

Fontes: `packages/shared/src/design.mjs:105`, `packages/shared/src/design-components.mjs`, `packages/core/src/bundled-skills/design/SKILL.md`.

### 4. P2: reutilização e edição exigem trabalho mecânico demais

**Limitações confirmadas.** Uma instância não pode trocar texto, ícone ou estado: somente posição, parent, nome, visibilidade e lock. Componentes aninhados são recusados. Uma simulação direta da sincronização confirmou que o texto da origem substitui um texto diferente colocado na instância; a API de edição impede essa alteração antes da sincronização. Isso é comportamento deliberado, não perda silenciosa pela API.

`design_apply` também não oferece atualização incremental de tokens ou propriedades do documento. O agente precisa reenviar o documento para essas mudanças. O schema exposto de `patch` é aberto, enquanto a validação final é estrita: parte das regras só aparece ao errar.

**Proposta:** propriedades explícitas de componentes (`label`, `icon`, `state`), atualização de tokens e metadados sem substituir a tela, descoberta das propriedades editáveis e pré-validação sem salvar. Acrescentar operações de duplicação e desanexação onde reduzirem reenvio de JSON. Preservar atomicidade e `expectedVersion` em todas as escritas.

**Aceite:** dois botões usam o mesmo componente com textos distintos; alterações de estilo atualizam ambos; uma troca de token não exige reenviar todas as camadas; entradas inválidas retornam caminho do campo e correção possível.

Fontes: `packages/shared/src/design.mjs:136`, `packages/shared/src/design.mjs:246`, `packages/shared/src/design-components.mjs:54`.

### 5. P1: falta evidência comparável entre modelos

**Confirmado no harness revisado.** `live-design-harness.cjs` restringe o provedor a Codex. O workflow verifica criação, revisão e preservação de uma edição manual. A documentação registra um benchmark pequeno de HTML versus documento estruturado, sem equivalência de qualidade visual. Isso não demonstra consistência entre Claude, GPT e outros modelos.

**Proposta:** matriz de provedores/modelos com briefs fixos, mesma versão de skill e kit, múltiplas repetições e casos de criação, revisão, troca de modelo, conflito de versão, feedback e retomada. Separar avaliação determinística da avaliação visual humana.

**Métricas:** uso correto da ferramenta, validade na primeira tentativa, preservação de ids e edições humanas, adesão ao kit, defeitos de layout, avisos restantes, tentativas, tokens e tempo. Avaliar se cada provedor recebe a imagem e consegue identificar um detalhe dela. Comparar qualidade por critérios comuns, sem exigir pixels idênticos de composições livres.

Fontes: `scripts/live-design-harness.cjs:128`, `scripts/live-design-workflow.cjs`, `docs/design-tool-verification.md`.

## Sequência sugerida

1. Corrigir a normalização do contraste e adicionar inspeção somente leitura, com testes determinísticos.
2. Generalizar o harness para medir o estado atual e manter os mesmos casos nas próximas mudanças.
3. Introduzir o kit visual por Project e propriedades de componentes; testar criação e retomada entre modelos.

Mudanças de comportamento devem chegar ao desktop e mobile juntas. Esta proposta não exige por si só dependência nativa; qualquer implementação mobile deve confirmar o fingerprint antes de publicar OTA.

## Verificação da auditoria inicial e limites históricos

- Leitura do contrato compartilhado, skill, renderização, componentes, adaptador MCP, composição do runtime, editor desktop, visualização mobile e documentação do workflow.
- Execução direta de `designWarnings` em cinco entradas: as quatro cores brancas acima e `#888888` sobre branco. Este último não recebe aviso com o limite atual de 3:1.
- Execução direta de `synchronizeDesignComponents` para verificar a herança do texto da origem.
- A tentativa de executar a validação completa encontrou `ERR_MODULE_NOT_FOUND` para `zod`: este Worktree está sem essa dependência instalada. Não foi executada a suíte completa, nem comparação com provedores reais ou QA visual de desktop/mobile. As reproduções diretas usam os módulos deste Worktree que não dependem de Zod.
- Nenhum design do usuário, configuração, código do produto, publicação ou build foi alterado. Este arquivo é o único resultado persistido da auditoria.
