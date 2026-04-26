// src/services/payment.service.js

const axios = require('axios');
const jwt = require('jsonwebtoken');

class PaymentService {
  constructor(models, config) {
    this.UserModel = models?.User || models?.user;
    this.PurchasedContentModel = models?.PurchasedContent || models?.purchasedContent;
    this.MP_ACCESS_TOKEN = config.MP_ACCESS_TOKEN;
    this.JWT_SECRET = config.JWT_SECRET;
    this.DOMINIO_PUBLICO = config.DOMINIO_PUBLICO;
    this.logger = config.logger || console;
  }

  /**
   * Obtém o saldo de créditos de um usuário
   */
  async getUserCredits(userId) {
    try {
      const user = await this.UserModel.findOne({ userId });
      return user?.credits || 0;
    } catch (error) {
      this.logger.error(`[PaymentService] Erro ao obter créditos do usuário ${userId}:`, error.message);
      return 0;
    }
  }

  /**
   * Adiciona créditos ao saldo do usuário
   */
  async addCredits(userId, centavos) {
    try {
      const user = await this.UserModel.findOne({ userId });
      if (!user) {
        this.logger.warn(`[PaymentService] Usuário ${userId} não encontrado ao adicionar créditos`);
        return false;
      }

      user.credits = (user.credits || 0) + centavos;
      user.lastAccess = new Date();
      await user.save();
      
      this.logger.info(`[PaymentService] Adicionados ${centavos} centavos ao usuário ${userId}. Novo saldo: ${user.credits}`);
      return true;
    } catch (error) {
      this.logger.error(`[PaymentService] Erro ao adicionar créditos para ${userId}:`, error.message);
      return false;
    }
  }

  /**
   * Deduz créditos do saldo do usuário
   */
  async deductCredits(userId, centavos) {
    try {
      const user = await this.UserModel.findOne({ userId });
      if (!user) return false;

      if (user.credits < centavos) {
        return { success: false, reason: 'insufficient_credits' };
      }

      user.credits -= centavos;
      await user.save();
      
      this.logger.info(`[PaymentService] Deduzidos ${centavos} centavos do usuário ${userId}. Saldo restante: ${user.credits}`);
      return { success: true, newBalance: user.credits };
    } catch (error) {
      this.logger.error(`[PaymentService] Erro ao deduzir créditos para ${userId}:`, error.message);
      return { success: false, reason: 'error' };
    }
  }

  /**
   * Cria um pagamento PIX no Mercado Pago
   */
  async createPixPayment(userId, valorCentavos) {
    if (!this.MP_ACCESS_TOKEN) {
      this.logger.error('[PaymentService] MP_ACCESS_TOKEN não configurado');
      return null;
    }

    const valorReais = valorCentavos / 100;
    const idempotencyKey = `${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const paymentData = {
      transaction_amount: valorReais,
      description: `FastTV - Créditos R$ ${valorReais.toFixed(2)}`,
      payment_method_id: 'pix',
      payer: {
        email: `user${userId}@fasttv.com`,
        first_name: 'Cliente',
        last_name: 'FastTV',
        identification: { type: 'CPF', number: '12345678909' }
      },
      notification_url: `${this.DOMINIO_PUBLICO}/webhook/mercadopago`,
      external_reference: userId.toString(),
      metadata: { user_id: userId.toString(), amount_cents: valorCentavos }
    };

    try {
      const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
        headers: {
          Authorization: `Bearer ${this.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey
        },
        timeout: 15000
      });

      const payment = response.data;

      if (payment.status !== 'pending' || payment.status_detail !== 'pending_waiting_transfer') {
        this.logger.warn(`[PaymentService] PIX gerado mas status inesperado: ${payment.status}`);
        return null;
      }

      const pixData = payment.point_of_interaction?.transaction_data;
      if (!pixData || !pixData.qr_code || !pixData.qr_code_base64) {
        this.logger.error('[PaymentService] Resposta do Mercado Pago sem dados de QR code');
        return null;
      }

      this.logger.info(`[PaymentService] PIX criado com sucesso. Payment ID: ${payment.id}`);

      return {
        paymentId: payment.id,
        pix_code: pixData.qr_code,
        pix_qr_base64: pixData.qr_code_base64,
        ticket_url: pixData.ticket_url || null,
        userId,
        amount: valorCentavos,
        idempotencyKey
      };
    } catch (error) {
      this.logger.error('[PaymentService] Erro ao criar PIX:', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Verifica o status de um pagamento no Mercado Pago
   */
  async checkPaymentStatus(paymentId) {
    if (!this.MP_ACCESS_TOKEN) return null;

    try {
      const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${this.MP_ACCESS_TOKEN}` },
        timeout: 10000
      });

      return {
        status: response.data.status,
        statusDetail: response.data.status_detail,
        amount: response.data.transaction_amount
      };
    } catch (error) {
      this.logger.error(`[PaymentService] Erro ao consultar pagamento ${paymentId}:`, error.message);
      return null;
    }
  }

  /**
   * Processa um pagamento aprovado e adiciona créditos
   */
  async processApprovedPayment(paymentId, userId, amountCents) {
    try {
      const success = await this.addCredits(userId, amountCents);
      if (!success) {
        this.logger.error(`[PaymentService] Falha ao adicionar créditos após aprovação do pagamento ${paymentId}`);
        return false;
      }

      const saldo = await this.getUserCredits(userId);
      this.logger.info(`[PaymentService] Pagamento ${paymentId} processado com sucesso. Novo saldo: ${saldo}`);
      
      return { success: true, newBalance: saldo };
    } catch (error) {
      this.logger.error(`[PaymentService] Erro ao processar pagamento aprovado ${paymentId}:`, error.message);
      return false;
    }
  }

  /**
   * Gera um token JWT para acesso ao conteúdo
   */
  generateAccessToken(userId, contentId, expirationHours = 24) {
    try {
      const payload = {
        userId,
        contentId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (expirationHours * 3600)
      };

      const token = jwt.sign(payload, this.JWT_SECRET);
      this.logger.info(`[PaymentService] Token gerado para usuário ${userId}, conteúdo ${contentId}, expira em ${expirationHours}h`);
      
      return token;
    } catch (error) {
      this.logger.error('[PaymentService] Erro ao gerar token JWT:', error.message);
      return null;
    }
  }

  /**
   * Valida um token JWT
   */
  verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, this.JWT_SECRET);
      return decoded;
    } catch (error) {
      this.logger.warn('[PaymentService] Token JWT inválido:', error.message);
      return null;
    }
  }
}

module.exports = PaymentService;
