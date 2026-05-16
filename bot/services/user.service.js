const db = require('./db.service');
const config = require('../config');
const { normalizeTitle } = require('../utils/formatters');

async function verificarOuCriarUsuario(msg) {
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'Usuário';
  const lastName = msg.from.last_name || '';
  const username = msg.from.username || null;
  const languageCode = msg.from.language_code || 'pt-BR';
  const isPremium = msg.from.is_premium || false;

  try {
    const UserModel = db.getUserModel();
    if (!UserModel || typeof UserModel.findOne !== 'function') return null;

    let user = await UserModel.findOne({ userId });

    if (!user) {
      user = new UserModel({
        userId, firstName, lastName, username,
        credits: 0, isActive: true, isBlocked: false,
        registeredAt: new Date(), lastAccess: new Date(),
        metadata: { telegramLanguageCode: languageCode, isPremium }
      });
      await user.save();
      return { isNew: true, user };
    }

    user.lastAccess = new Date();
    user.firstName = firstName;
    user.lastName = lastName;
    user.username = username;
    await user.save();
    return { isNew: false, user };
  } catch (error) {
    console.error('Erro ao verificar/criar usuário:', error);
    return null;
  }
}

async function verificarBloqueio(userId) {
  try {
    const UserModel = db.getUserModel();
    const user = await UserModel.findOne({ userId });
    if (user && user.isBlocked) {
      return { blocked: true, reason: user.blockedReason || 'Sua conta foi bloqueada pelo administrador.' };
    }
    return { blocked: false };
  } catch (error) {
    console.error('Erro ao verificar bloqueio:', error);
    return { blocked: false };
  }
}

// Bônus inicial (precisa importar dependência de pagamento do módulo vizinho para addCredits)
async function concederBonusInicialSeElegivel(user, isNewUser, paymentAdapter) {
  if (!isNewUser || !user || config.BONUS_INICIAL_NOVO_USUARIO <= 0) {
    return { granted: false, amount: 0 };
  }

  try {
    const UserModel = db.getUserModel();
    const reservado = await UserModel.findOneAndUpdate(
      { userId: user.userId, 'metadata.initialBonusGranted': { $ne: true } },
      {
        $set: {
          'metadata.initialBonusGranted': true,
          'metadata.initialBonusGrantedAt': new Date(),
          'metadata.initialBonusAmount': config.BONUS_INICIAL_NOVO_USUARIO
        }
      },
      { new: true }
    );

    if (!reservado) return { granted: false, amount: 0 };

    const creditado = await paymentAdapter.addCredits(user.userId, config.BONUS_INICIAL_NOVO_USUARIO);
    if (!creditado) {
      await UserModel.updateOne(
        { userId: user.userId },
        {
          $set: { 'metadata.initialBonusGranted': false },
          $unset: { 'metadata.initialBonusGrantedAt': '', 'metadata.initialBonusAmount': '' }
        }
      );
      return { granted: false, amount: 0 };
    }

    return { granted: true, amount: config.BONUS_INICIAL_NOVO_USUARIO };
  } catch (error) {
    console.error('Erro ao conceder bônus inicial:', error.message);
    return { granted: false, amount: 0 };
  }
}

function getPurchaseVisibilityFilter(extra = {}) {
  return { ...extra, source: { $ne: 'batch' }, token: { $not: /^batch-/ } };
}

async function getOwnedMoviesSet(userId, ids) {
  const PurchasedContentModel = db.getPurchasedContentModel();
  if (!PurchasedContentModel || typeof PurchasedContentModel.find !== 'function') return new Set();
  const uniqueIds = Array.from(new Set((ids || []).map((id) => String(id))));
  if (uniqueIds.length === 0) return new Set();

  const rows = await PurchasedContentModel.find({
    userId, mediaType: 'movie', videoId: { $in: uniqueIds },
    ...getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
  }).select('videoId');

  return new Set(rows.map((r) => String(r.videoId)));
}

async function getOwnedEpisodesSet(userId, title, season, episodeIds) {
  const PurchasedContentModel = db.getPurchasedContentModel();
  if (!PurchasedContentModel || typeof PurchasedContentModel.find !== 'function') return new Set();
  const ids = Array.from(new Set((episodeIds || []).map((id) => String(id))));
  if (ids.length === 0) return new Set();

  const rows = await PurchasedContentModel.find({
    userId, mediaType: 'series', title: String(title || ''), season: String(season || ''),
    videoId: { $in: ids },
    ...getPurchaseVisibilityFilter({ expiresAt: { $gt: new Date() } })
  }).select('videoId');

  return new Set(rows.map((r) => String(r.videoId)));
}

module.exports = {
  verificarOuCriarUsuario,
  verificarBloqueio,
  concederBonusInicialSeElegivel,
  getPurchaseVisibilityFilter,
  getOwnedMoviesSet,
  getOwnedEpisodesSet
};