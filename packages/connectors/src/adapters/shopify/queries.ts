/**
 * GraphQL documents (API version pinned in client.ts). Field names follow the public Admin API schema.
 * Nested connection sizes are kept small so the requested cost stays below the 1,000-point single-query limit.
 */
export const PAGE_SIZE = { orders: 10, line_items: 25, inventory_items: 25, inventory_levels: 10, fulfillment_orders: 20, payouts: 50, balance_transactions: 50, disputes: 50 };

export const SHOP_QUERY = `query BlackboxShop { shop { id name myshopifyDomain currencyCode ianaTimezone } }`;

export const SCOPES_QUERY = `query BlackboxScopes { currentAppInstallation { id accessScopes { handle } } }`;

export const ORDERS_COUNT_QUERY = `query BlackboxOrdersCount($query: String) { ordersCount(query: $query, limit: 10000) { count precision } }`;

const MONEY = `shopMoney { amount currencyCode }`;

export const ORDERS_QUERY = `query BlackboxOrders($first: Int!, $after: String, $query: String, $lineItems: Int!) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt cancelledAt closedAt test currencyCode
      displayFinancialStatus displayFulfillmentStatus
      customer { id }
      originalTotalPriceSet { ${MONEY} }
      currentTotalPriceSet { ${MONEY} }
      totalShippingPriceSet { ${MONEY} }
      totalTaxSet { ${MONEY} }
      totalDiscountsSet { ${MONEY} }
      lineItems(first: $lineItems) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id sku quantity currentQuantity unfulfilledQuantity
          variant { id inventoryItem { id } }
          originalTotalSet { ${MONEY} }
          discountedTotalSet { ${MONEY} }
          totalDiscountSet { ${MONEY} }
          taxLines { priceSet { ${MONEY} } }
        }
      }
      transactions {
        id kind status test gateway processedAt createdAt errorCode
        amountSet { ${MONEY} }
        parentTransaction { id }
      }
      fulfillments {
        id status createdAt updatedAt inTransitAt deliveredAt
        location { id }
        trackingInfo { company number }
        fulfillmentLineItems(first: 25) { pageInfo { hasNextPage } nodes { id quantity lineItem { id } } }
      }
      refunds {
        id createdAt updatedAt
        totalRefundedSet { ${MONEY} }
        refundLineItems(first: 25) { pageInfo { hasNextPage } nodes { quantity restockType restocked location { id } lineItem { id } } }
        transactions(first: 10) { pageInfo { hasNextPage } nodes { id kind status test gateway processedAt amountSet { ${MONEY} } parentTransaction { id } } }
      }
      returns(first: 5) {
        pageInfo { hasNextPage }
        nodes {
          id status
          returnLineItems(first: 25) { pageInfo { hasNextPage } nodes { id quantity ... on ReturnLineItem { fulfillmentLineItem { lineItem { id } } } } }
          reverseFulfillmentOrders(first: 5) {
            nodes { id status lineItems(first: 25) { nodes { id fulfillmentLineItem { lineItem { id } } dispositions { id type quantity location { id } } } } }
          }
        }
      }
    }
  }
}`;

export const ORDER_LINE_ITEMS_QUERY = `query BlackboxOrderLineItems($id: ID!, $first: Int!, $after: String) {
  order(id: $id) {
    id
    lineItems(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id sku quantity currentQuantity unfulfilledQuantity
        variant { id inventoryItem { id } }
        originalTotalSet { ${MONEY} }
        discountedTotalSet { ${MONEY} }
        totalDiscountSet { ${MONEY} }
        taxLines { priceSet { ${MONEY} } }
      }
    }
  }
}`;

export const INVENTORY_ITEMS_QUERY = `query BlackboxInventoryItems($first: Int!, $after: String, $query: String, $levels: Int!) {
  inventoryItems(first: $first, after: $after, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku tracked updatedAt
      inventoryLevels(first: $levels) {
        pageInfo { hasNextPage }
        nodes {
          id updatedAt
          location { id }
          quantities(names: ["available", "on_hand", "committed", "reserved", "damaged", "safety_stock", "quality_control", "incoming"]) { name quantity }
        }
      }
    }
  }
}`;

export const FULFILLMENT_ORDERS_QUERY = `query BlackboxFulfillmentOrders($first: Int!, $after: String, $query: String) {
  fulfillmentOrders(first: $first, after: $after, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id status requestStatus updatedAt createdAt
      assignedLocation { location { id } }
      order { id }
      lineItems(first: 25) { pageInfo { hasNextPage } nodes { id totalQuantity remainingQuantity lineItem { id } inventoryItemId } }
    }
  }
}`;

export const PAYMENTS_ACCOUNT_QUERY = `query BlackboxPaymentsAccount {
  shopifyPaymentsAccount { id activated defaultCurrency country balance { amount currencyCode } }
}`;

export const PAYOUTS_QUERY = `query BlackboxPayouts($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    id
    payouts(first: $first, after: $after, query: $query, sortKey: ISSUED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id status issuedAt transactionType
        net { amount currencyCode }
        summary { chargesFee { amount currencyCode } chargesGross { amount currencyCode } refundsFee { amount currencyCode } refundsFeeGross { amount currencyCode } adjustmentsFee { amount currencyCode } adjustmentsGross { amount currencyCode } reservedFundsFee { amount currencyCode } reservedFundsGross { amount currencyCode } retriedPayoutsFee { amount currencyCode } retriedPayoutsGross { amount currencyCode } }
      }
    }
  }
}`;

export const BALANCE_TRANSACTIONS_QUERY = `query BlackboxBalanceTransactions($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    id
    balanceTransactions(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id type test transactionDate
        amount { amount currencyCode }
        fee { amount currencyCode }
        net { amount currencyCode }
        sourceId sourceType sourceOrderTransactionId adjustmentReason
        associatedOrder { id }
        associatedPayout { id status }
      }
    }
  }
}`;

export const DISPUTES_QUERY = `query BlackboxDisputes($first: Int!, $after: String, $query: String) {
  shopifyPaymentsAccount {
    id
    disputes(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id status type initiatedAt finalizedOn evidenceDueBy
        amount { amount currencyCode }
        reasonDetails { reason networkReasonCode }
        order { id }
      }
    }
  }
}`;
