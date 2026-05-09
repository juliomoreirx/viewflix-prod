const logger = require('../lib/logger');

/**
 * LiveTV Buffer Provisioner
 * Auto-cria e gerencia perfis de buffer para todos os canais LiveTV
 */

class LiveTvBufferProvisioner {
  constructor() {
    this.isProvisioning = false;
    this.lastProvisionAt = null;
    this.provisionedChannels = new Set();
  }

  /**
   * Provisiona todos os canais LiveTV com defaults otimizados
   */
  async provisionAllChannels(catalogLiveTV, LiveTvBufferProfile) {
    if (this.isProvisioning) {
      logger.info({ msg: 'LiveTV provisioning já em progresso, aguardando...' });
      return;
    }

    this.isProvisioning = true;
    const startTime = Date.now();

    try {
      if (!catalogLiveTV || catalogLiveTV.length === 0) {
        logger.warn({ msg: 'Nenhum canal LiveTV disponível para provisionar' });
        return;
      }

      logger.info({ msg: `Iniciando provisioning de ${catalogLiveTV.length} canais LiveTV` });

      const channelIds = catalogLiveTV.map((item) => String(item?.id || '').trim()).filter(Boolean);
      const existingProfiles = await LiveTvBufferProfile.find(
        { channelId: { $in: channelIds } },
        { channelId: 1, enabled: 1, status: 1 }
      ).lean();

      const existingMap = new Map(existingProfiles.map((p) => [p.channelId, p]));

      // Calcular quantos já existem e precisam ser criados
      const toCreate = channelIds.filter((id) => !existingMap.has(id));
      logger.info({ msg: `Profiles existentes: ${existingMap.size}, a criar: ${toCreate.length}` });

      if (toCreate.length === 0) {
        logger.info({ msg: 'Todos os canais já possuem perfis de buffer' });
        this.lastProvisionAt = new Date();
        return;
      }

      // Criar profiles em batch
      const bulkOps = toCreate.map((channelId) => {
        const catalogItem = catalogLiveTV.find((item) => String(item?.id || '') === channelId);
        const channelTitle = String(catalogItem?.name || catalogItem?.title || catalogItem?.label || channelId).trim();

        return {
          insertOne: {
            document: {
              channelId,
              channelTitle,
              enabled: true,
              // Valores otimizados para evitar choppiness:
              // - segmentDurationSec: 10s (em vez de 6s) = mais dados por segmento
              // - segmentCount: 60 (em vez de 30) = buffer total de 600s (10 minutos)
              segmentDurationSec: 10,
              segmentCount: 60,
              warmupMode: 'on-demand',
              status: 'idle',
              createdAt: new Date(),
              updatedAt: new Date()
            }
          }
        };
      });

      if (bulkOps.length > 0) {
        const result = await LiveTvBufferProfile.bulkWrite(bulkOps, { ordered: false });
        logger.info({
          msg: 'Provisioning concluído',
          inserted: result.insertedCount,
          duration: `${Date.now() - startTime}ms`
        });
        toCreate.forEach((id) => this.provisionedChannels.add(id));
      }

      this.lastProvisionAt = new Date();
    } catch (error) {
      logger.error({
        msg: 'Erro ao provisionar canais LiveTV',
        error: error.message,
        stack: error.stack
      });
    } finally {
      this.isProvisioning = false;
    }
  }

  /**
   * Inicia warmup automático para canais habilitados
   */
  async startAutoWarmup(LiveTvBufferProfile) {
    try {
      // Encontrar canais com status 'idle' e enabled = true
      const channelsToWarmup = await LiveTvBufferProfile.find(
        { enabled: true, status: 'idle' },
        { channelId: 1, warmupMode: 1 }
      ).lean();

      if (channelsToWarmup.length === 0) {
        logger.info({ msg: 'Nenhum canal LiveTV para warmup automático' });
        return;
      }

      logger.info({ msg: `Iniciando warmup de ${channelsToWarmup.length} canais LiveTV` });

      // Disparar warmup assincronamente (não bloqueia)
      const warmupPromises = channelsToWarmup.map((profile) =>
        LiveTvBufferProfile.updateOne(
          { channelId: profile.channelId },
          {
            $set: {
              status: 'warming',
              lastWarmupAt: new Date(),
              statusNote: 'Auto-warmup no boot'
            }
          }
        ).catch((err) => {
          logger.warn({
            msg: 'Erro ao setar warmup para canal',
            channelId: profile.channelId,
            error: err.message
          });
        })
      );

      await Promise.allSettled(warmupPromises);
      logger.info({ msg: 'Auto-warmup disparado com sucesso' });
    } catch (error) {
      logger.error({
        msg: 'Erro ao iniciar auto-warmup',
        error: error.message
      });
    }
  }

  /**
   * Retorna estatísticas de provisioning
   */
  getStats() {
    return {
      isProvisioning: this.isProvisioning,
      lastProvisionAt: this.lastProvisionAt,
      provisionedChannels: this.provisionedChannels.size
    };
  }
}

module.exports = new LiveTvBufferProvisioner();
