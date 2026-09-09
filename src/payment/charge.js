// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const { context, propagation, trace, metrics } = require('@opentelemetry/api');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');

const { OpenFeature } = require('@openfeature/server-sdk');
const { FlagdProvider } = require('@openfeature/flagd-provider');
const flagProvider = new FlagdProvider();

const logger = require('./logger');
const tracer = trace.getTracer('payment');
const meter = metrics.getMeter('payment');
const transactionsCounter = meter.createCounter('app.payment.transactions');

const LOYALTY_LEVEL = ['platinum', 'gold', 'silver', 'bronze'];

/** Pick a uniformly random element from the given array */
function pickRandom(arr) {
  const index = Math.floor(Math.random() * arr.length);
  return arr[index];
}

module.exports.charge = async request => {
  const span = tracer.startSpan('charge');

  await OpenFeature.setProviderAndWait(flagProvider);

  const failureRate = await OpenFeature.getClient().getNumberValue("paymentFailure", 0);

  if (failureRate > 0) {
    // Fail this fraction of requests, tagged app.loyalty.level=gold
    if (Math.random() < failureRate) {
      span.setAttributes({'app.loyalty.level': 'gold' });
      span.end();

      throw new Error('Payment request failed. Invalid token. app.loyalty.level=gold');
    }
  }

  const {
    creditCardNumber: number,
    creditCardExpirationYear: year,
    creditCardExpirationMonth: month
  } = request.creditCard;
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  const lastFourDigits = number.substr(-4);
  const transactionId = uuidv4();

  const card = cardValidator(number);
  const { card_type: cardType, valid } = card.getCardDetails();

  const loyalty_level = pickRandom(LOYALTY_LEVEL);

  span.setAttributes({
    'app.payment.card_type': cardType,
    'app.payment.card_valid': valid,
    'app.loyalty.level': loyalty_level
  });

  if (!valid) {
    throw new Error('Credit card info is invalid.');
  }

  if (!['visa', 'mastercard'].includes(cardType)) {
    throw new Error(`Sorry, we cannot process ${cardType} credit cards. Only VISA or MasterCard is accepted.`);
  }

  if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {
    throw new Error(`The credit card (ending ${lastFourDigits}) expired on ${month}/${year}.`);
  }

  // Synthetic (load-generator) requests are marked via baggage; don't count them as real charges
  const baggage = propagation.getBaggage(context.active());
  if (baggage && baggage.getEntry('synthetic_request') && baggage.getEntry('synthetic_request').value === 'true') {
    span.setAttribute('app.payment.charged', false);
  } else {
    span.setAttribute('app.payment.charged', true);
  }

  const { units, nanos, currencyCode } = request.amount;
  logger.info({ transactionId, cardType, lastFourDigits, amount: { units, nanos, currencyCode }, loyalty_level }, 'Transaction complete.');
  transactionsCounter.add(1, { 'app.payment.currency': currencyCode });
  span.end();

  return { transactionId };
};
