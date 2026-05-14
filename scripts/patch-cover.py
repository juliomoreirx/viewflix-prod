from pathlib import Path

bot_path = Path(r"E:\Viewflix-bot\fasttv\telegram-bot.js")
lines = bot_path.read_text(encoding='utf-8').splitlines()

# import logger after bunny cache
for i, line in enumerate(lines):
    if line.strip() == "const bunnyCacheService = require('./src/services/bunny-cache.service');":
        if i + 1 < len(lines) and "const logger = require('./src/lib/logger');" not in lines[i + 1]:
            lines.insert(i + 1, "const logger = require('./src/lib/logger');")
        break

# add helper after getEstimarDuracao
for i, line in enumerate(lines):
    if line.strip() == "return async () => defaultMin;":
        helper = [
            "",
            "function toAbsoluteUrl(url = '') {",
            "  if (!url) return '';",
            "  if (/^https?:\\/\\//i.test(url)) return url;",
            "  const base = String(DOMINIO_PUBLICO || '').replace(/\\/$/, '');",
            "  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url;",
            "}",
        ]
        # only insert if helper absent right after the closing brace of getEstimarDuracao
        if i + 1 < len(lines) and lines[i + 1].strip() == '}':
            if not any('function toAbsoluteUrl(url = \'\') {' in l for l in lines[max(0, i - 3): i + 10]):
                lines[i + 2:i + 2] = helper
        break

# inject sendPhoto before the details message send
for i, line in enumerate(lines):
    if line.strip() == "await bot.sendMessage(chatId, mensagem, {":
        if not any("Enviando capa dos detalhes" in l for l in lines[max(0, i - 20):i]):
            block = [
                "",
                "      const coverUrl = toAbsoluteUrl(detalhes.coverUrl || detalhes.capa_url || detalhes.capa || '');",
                "      if (coverUrl) {",
                "        logger.info({",
                "          msg: 'Enviando capa dos detalhes',",
                "          chatId,",
                "          title: detalhes.title,",
                "          coverUrl",
                "        });",
                "",
                "        try {",
                "          await bot.sendPhoto(chatId, coverUrl, {",
                "            caption: detalhes.title ? ` ${detalhes.title}` : ' Detalhes do conteúdo'",
                "          });",
                "        } catch (error) {",
                "          logger.warn({",
                "            msg: 'Falha ao enviar capa dos detalhes',",
                "            chatId,",
                "            title: detalhes.title,",
                "            error: error.message",
                "          });",
                "        }",
                "      } else {",
                "        logger.info({",
                "          msg: 'Detalhes sem capa para enviar',",
                "          chatId,",
                "          title: detalhes.title",
                "        });",
                "      }",
                "",
            ]
            lines[i:i] = block
        break

bot_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print('patched', any('const logger = require(\'./src/lib/logger\');' in l for l in lines), any('function toAbsoluteUrl(url = \'\') {' in l for l in lines), any('Enviando capa dos detalhes' in l for l in lines))
