# Orbia: tela de configurações

Data: 2026-11-25. Aprovado pelo dono do projeto na conversa.

## Para que serve

Uma tela de configurações por IA. Ao trocar de IA, a tela mostra o que vale para aquela IA. Junta duas coisas:

1. Opções do próprio Orbia por IA, guardadas na pasta de dados do app (`opcoes.json`). Valem só nas conversas pelo Orbia.
2. Edição da configuração das ferramentas: skills, MCPs, regras e plugins do Claude Code. Isso muda o que acontece também no terminal.

## Mudança de regra

O spec original listava "alterar arquivos ou configurações das ferramentas" como falha. O dono decidiu que a tela de configurações pode editar. Proteções:

- Sempre que existe comando oficial, o Orbia usa ele: `claude mcp add/remove -s user`, `claude plugin enable/disable`.
- Arquivos de texto (`~/.claude/CLAUDE.md`, `~/.claude/skills/<nome>/SKILL.md`) são editados direto, com cópia `.bak` antes de sobrescrever.
- Apagar uma skill pede confirmação.
- Nenhum comando genérico de rodar processo: cada ação tem o seu comando no backend, com os argumentos validados.

## O que tem em cada IA

- Todas: aba Geral com o tema (vale para o app todo). A troca de tema sai do topo; no lugar entra a engrenagem.
- Claude: Geral (tema, modelo padrão para novas conversas, instrução extra via `--append-system-prompt`), Skills (suas: criar, editar, apagar; de plugin: ativar e desativar o plugin; as que vêm com o Claude Code: só leitura), MCPs (lista com status; adicionar e remover os do escopo do usuário), Regras (`~/.claude/CLAUDE.md`).
- Ollama: Geral e Modelo (detalhes do modelo; instrução de sistema, temperatura e tamanho do contexto, enviados em `/api/chat`).
- Gemini e Codex: só Geral por enquanto. Não estão instalados na máquina de desenvolvimento, então não dá para testar a edição.

## Abordagens

1. Comandos oficiais quando existem, arquivo de texto direto com `.bak` (escolhida): a ferramenta valida a própria configuração.
2. Editar JSON e TOML direto: uniforme entre ferramentas, mas um erro pode corromper a configuração delas.

## Fica para quem construir

Layout das abas, textos, estados de carregamento e erro.
