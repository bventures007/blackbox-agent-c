#!/usr/bin/env python3
"""Generates the committed per-capability mapping artifacts for the Shopify and Shopify Payments rows.
Run: python3 integrations/mappings/_generate_mappings.py && python3 integrations/mappings/validate-mappings.py
The artifacts are the reviewable contract; this script only keeps shared text consistent. Facts here were
verified against the fixture-driven adapter code (packages/connectors) and the public 2026-10 schema pages
cited in docs/connectors.md; anything not verifiable offline is marked as such in the limitations text."""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(__file__).resolve().parent
CONTRACT = json.loads((ROOT / 'specs' / 'question-data-contracts.json').read_text())
DATASETS = {d['id']: d for d in CONTRACT['datasets']}
API = '2026-10'
SOURCE_REVISION = f'Shopify GraphQL Admin API {API} (latest stable per shopify.dev/docs/api/usage/versioning on 2026-11-01; 2025-10 is listed unsupported)'
RETENTION = {'decision': 'permitted', 'basis': 'Shopify API License and Terms of Use, merchant-owned data, read-only custom app; the merchant owns its order/payout data and installs the app on its own store. Raw provider payloads are stored as sanitized evidence (no customer names/emails/addresses) under the workspace retention policy.'}
GATEWAY = {'status': 'unsupported', 'methods': [], 'schedule': 'none', 'history_limit': 'none', 'authentication': 'none', 'recovery': 'none', 'limitations': 'No gateway runtime exists in the pilot; declared and refused by the connector (LOCAL-07).', 'reason': 'local_gateway is deferred scope for the local pilot (delivery-profile.json); no gateway is provisioned and the capability declaration lists no methods for it.'}
PUBLIC = {'status': 'unsupported', 'methods': [], 'schedule': 'none', 'history_limit': 'none', 'authentication': 'none', 'recovery': 'none', 'limitations': 'No public callback is registered; localhost cannot receive Shopify webhooks.', 'reason': 'public_server is deferred scope for the local pilot; direct webhooks would require a public HTTPS endpoint that the pilot does not provide.'}
AUTH = 'Admin API access token for a merchant-installed custom app (X-Shopify-Access-Token), or the Dev Dashboard client-credentials grant (POST /admin/oauth/access_token, 24h token, refreshed one minute before expiry, no redirect URL). The token is stored encrypted on the connection (AES-256-GCM, key outside the database) and never logged.'
RECOVERY_POLL = 'Provider cursor and phase are persisted per page in import_runs.checkpoint / capability_health.*_cursor after COMMIT; a failed page never advances the checkpoint. Expired cursors restart the current phase from its floor (idempotent through the deliveries dedupe boundary). 401/403 stop polling with status reauthorization_required/degraded; 429 waits for Retry-After (fallback 1 s); 5xx retry with exponential backoff (max 5 attempts) then the run is re-queued with backoff; non-retryable failures become visible dead letters. After sleep/wake one coalesced poll per poll group plus one bounded overlap reconciliation (gap + overlap, capped at the reconcile window) is scheduled; no burst replay.'

def order_group_sync(dataset_word, time_rule, extra_limit='', status='supported'):
    return {
        'initial_import': f'Backfill phase "window": orders with created_at in [requested_from, initial_cutoff) read with BlackboxOrders (sortKey UPDATED_AT, first=10, nested lineItems first=25 with follow-up BlackboxOrderLineItems pages). Phase "open" (when the plan includes open items): orders created before requested_from that are still open/unpaid/unshipped (status:open OR financial_status pending/authorized/partially_paid OR fulfillment_status unshipped/partial). ordersCount(precision EXACT) provides the exact window total; otherwise totals stay unknown. {dataset_word} are read through their parent order on every page.',
        'cursor': f'Incremental: query updated_at:>=floor where floor = max(previous floor, min(newest updatedAt seen, now) - 900 s overlap); seeded at initial_cutoff - 900 s when the plan is created (initial_cutoff exactly for strict from-now). Page cursor = Relay endCursor within one phase. {time_rule}',
        'reconciliation': 'Every 6 h (and once after sleep/wake with a window bounded to 48 h) re-read updated_at within [to - window, to]; observations are deduplicated by provider_event_id, late revisions append order.revised, nothing is rewritten.',
        'deduplication': 'provider_event_id = "<shop numeric id>|<object>:<numeric id>|<state or revision>" is unique per (tenant, connection); identical content is a duplicate delivery (attempts++), different content under the same identity appends source.conflict_observed and opens a review case. Shop-side refunds and Shopify Payments ledger refunds share economic_effect_id = shopify:transaction:<id>.',
        'freshness': 'Default poll every 300 s (adjustable 60 s to 3600 s, jitter up to 30 s); last_successful_check_at advances only after a complete successful poll, last_new_event_at only when entries were committed; a credential check never advances either. Observed freshness is reported from these timestamps, never promised.' + (' ' + extra_limit if extra_limit else ''),
        'modes': {
            'local_standalone': {'status': status, 'methods': ['polling'], 'schedule': 'Incremental poll every 300 s (bounds 60-3600 s, jitter 30 s); reconciliation every 6 h over a 48 h window; backfill paged with checkpoints.', 'history_limit': 'Default order access is the last 60 days; older orders require the read_all_orders approval. Only the current version of an order is observable; edits before the first poll are not reconstructed.', 'authentication': AUTH, 'recovery': RECOVERY_POLL, 'limitations': 'No webhooks: changes are seen at the next poll. Nested connections beyond the selected page sizes are flagged truncated_connections (lineItems are completed by follow-up pages). ' + extra_limit, 'reason': 'Outbound GraphQL polling needs no inbound route and is supported in local_standalone.' if status == 'supported' else 'Outbound polling works for the declared field subset; the listed missing fields/unsupported events keep the capability partial.'},
            'local_gateway': GATEWAY, 'public_server': PUBLIC,
        },
    }

def finance_sync(obj, filter_field, limit):
    return {
        'initial_import': f'Backfill reads shopifyPaymentsAccount.{obj} with the query filter {filter_field}:>=requested_from AND {filter_field}:<=initial_cutoff, first=50, Relay cursor pagination; the provider gives no exact count, so totals stay unknown (counts/phase shown instead of a percentage).',
        'cursor': f'Incremental: {filter_field}:>=floor where floor = max(previous floor, min(newest {filter_field} seen, now) - 3600 s); page cursor = Relay endCursor. {limit}',
        'reconciliation': 'Every 24 h (and once after sleep/wake, bounded to 7 days) re-read the window; deduplicated by provider_event_id.',
        'deduplication': 'provider_event_id = "<shop numeric id>|<object>:<numeric id>|<state>"; identical content duplicates, differing content conflicts (review case). Economic identity: sourceOrderTransactionId links a ledger entry to the shop transaction; adjustments without a source keep their own identity.',
        'freshness': 'Default poll every 1800 s (300 s to 24 h, jitter 120 s); successful-check and new-event timestamps are separate; payout status is a provider assertion until bank evidence (bank_csv) confirms it.',
        'modes': {
            'local_standalone': {'status': 'partial', 'methods': ['polling'], 'schedule': 'Poll every 1800 s (bounds 300 s-24 h, jitter 120 s); reconciliation every 24 h over 7 days.', 'history_limit': 'Account history as exposed by the pinned API; the exact retention of balance transactions on the account is not verifiable offline and is recorded from the live account at SLICE-02/SOURCE-01 time.', 'authentication': AUTH + ' Additionally requires an active Shopify Payments account (shopifyPaymentsAccount.activated) and the read_shopify_payments_payouts scope (view_payouts permission); disputes need read_shopify_payments_disputes.', 'recovery': RECOVERY_POLL, 'limitations': limit, 'reason': 'Outbound polling of the Shopify Payments account works for the declared subset; missing fields keep the capability partial.'},
            'local_gateway': GATEWAY, 'public_server': PUBLIC,
        },
    }

def readiness(time_selection, historical, open_related, opening, progress, readiness_rules, health, expansion, handling):
    return {'time_selection': time_selection, 'historical_availability': historical, 'open_and_related_records': open_related, 'opening_state': opening, 'progress_accounting': progress, 'readiness_rules': readiness_rules, 'health_rules': health, 'history_expansion': expansion, 'data_handling': handling}

ORDER_READINESS = dict(
    time_selection='Order.createdAt selects the import window (business occurrence); Order.updatedAt selects incremental/reconciliation reads (last modification). Observation time is the poll time; recorded_at is the actual journal commit time and is never backdated.',
    historical='Default order access covers the last 60 days; older orders need the read_all_orders approval, which is recorded as a restriction on the plan and shown as an accessible-period limit. The current order version is observable, not its intermediate edits: history_kind event_history for new activity, snapshot for the state at first read.',
    open_related='With include_open_items the "open" backfill phase retrieves orders created before the window that are still open/unpaid/unshipped; their transactions, fulfillments, refunds and returns come with the order. Traversal is bounded to the order and its nested objects; no unrelated customer history is crawled.',
    opening='No opening balance applies to orders; the first read of an older open order is a snapshot of its current state labeled observation_mode=backfill, never a new sale.',
    progress='requested = exact ordersCount of the window (precision EXACT) plus open phase; loaded = orders fetched; committed = distinct logical records with a new journal entry; duplicates/conflicts/rejected are separate; totals_known is true only for backfills with exact counts. Percentages are only shown for the backfill fetch stage.',
    readiness_rules='Order questions are ready when the connection has a completed backfill for the declared window and the incremental cursor is current within the schedule; partial when the open phase or line-item follow-ups are incomplete (truncated_connections) or the 60-day limit cuts the requested window; blocked without read_orders.',
    health='healthy after a complete successful poll within interval + jitter; degraded after a failed/partial poll, missing grant or conflicts; unavailable on provider 5xx/429 beyond retries; paused on storage critical. next_check_at is null with a reason (no_import_plan, missing_grant, storage_critical).',
    expansion='A new plan revision creates a history_expansion/backfill run over the additional interval; overlaps are deduplicated by provider_event_id; recorded_at of new entries is the actual import time; prior coverage is preserved.',
    handling='Only opaque gids, amounts, quantities, statuses and timestamps enter payloads; customer is referenced by gid only; evidence stores the sanitized provider object without names, emails or addresses.',
)

def order_row(dataset, fields, events, extra_limit, emits_note):
    r = dict(ORDER_READINESS)
    status = 'supported' if dataset in ('orders', 'payments') else 'partial'  # mirrors SHOPIFY_CAPABILITIES in packages/connectors
    return {
        'row_id': f'shopify.{dataset}', 'source_revision': SOURCE_REVISION,
        'input_resources': ['Order', 'LineItem'] + {'orders': [], 'payments': ['OrderTransaction'], 'fulfillments': ['Fulfillment', 'FulfillmentLineItem', 'FulfillmentTrackingInfo'], 'refunds': ['Refund', 'OrderTransaction', 'RefundLineItem'], 'returns': ['Return', 'ReturnLineItem'], 'receipts': ['Return', 'ReverseFulfillmentOrder', 'ReverseFulfillmentOrderLineItem', 'ReverseFulfillmentOrderDisposition']}[dataset],
        'grants': {'orders': ['read_orders'], 'payments': ['read_orders'], 'fulfillments': ['read_orders', 'read_fulfillments'], 'refunds': ['read_orders'], 'returns': ['read_orders', 'read_returns'], 'receipts': ['read_orders', 'read_returns']}[dataset] + ['read_all_orders (only for orders older than 60 days)'],
        'identity_rule': 'Account scope = Shop.id (immutable gid, compared on every credential check; a different shop requires a new connection). Record identity = provider gid; provider_event_id = "<shop numeric id>|<object>:<numeric id>|<state or updatedAt>"; entity_refs carry order/customer/transaction/shipment/return/receipt gids.',
        'coverage_rule': 'Coverage = plan window [requested_from, initial_cutoff) plus the open phase, then continuous from the incremental floor; coverage_to advances only after a complete successful poll. The 60-day default access limit and unreadable nested pages are reported as restrictions, never silently shortened.',
        'retention': RETENTION, 'fields': fields, 'event_rules': events,
        'synchronization': order_group_sync(emits_note, 'Transactions, fulfillments, refunds and returns are versioned by their parent order updatedAt.', extra_limit, status),
        'import_readiness': readiness(**r),
    }

def F(status, normalization, missing_behavior, **k):
    d = {'status': status, 'normalization': normalization, 'missing_behavior': missing_behavior}; d.update(k); return d

PIECE = F('derived', 'Constant unit "piece": Shopify line quantities are integer counts without a unit field.', 'Not applicable (constant).', rule='connectors.normalize.shopify.v1: unit = "piece" for all Shopify quantities.')

rows = {}
rows['shopify.orders'] = order_row('orders', {
    'order_id': F('source', 'Opaque gid string.', 'Order without id is rejected (missing_required_field).', source_path='Order.id'),
    'line_id': F('source', 'Opaque gid per line; lines beyond the first 25 are fetched with BlackboxOrderLineItems follow-up pages.', 'Order without lines yields an order record with an empty lines array.', source_path='Order.lineItems.nodes[].id'),
    'customer_id': F('source', 'Opaque gid only; no name/email.', 'null for guest checkouts (no fabricated customer).', source_path='Order.customer.id'),
    'item_id': F('source', 'InventoryItem gid (joins stock snapshots).', 'null for custom/non-product lines (no fabricated SKU); stock questions treat the line as unlinked.', source_path='Order.lineItems.nodes[].variant.inventoryItem.id'),
    'variant_id': F('source', 'ProductVariant gid.', 'null for custom lines.', source_path='Order.lineItems.nodes[].variant.id'),
    'quantity': F('source', 'Decimal string; order.accepted uses quantity (as ordered), order.revised uses currentQuantity (after removals/refunds) and also carries ordered_quantity/unfulfilled_quantity.', 'Required; a line without quantity is rejected.', source_path='Order.lineItems.nodes[].quantity | currentQuantity'),
    'unit': PIECE,
    'currency': F('source', 'ISO 4217 code from the order; all money on the record uses shopMoney in this currency.', 'Required; rejected when absent.', source_path='Order.currencyCode (and *.shopMoney.currencyCode)'),
    'line_net_minor': F('source', 'Integer minor units via exact decimal parsing. order.accepted: originalTotalSet (pre-discount, pre-tax, as ordered); order.revised: discountedTotalSet (after discounts, before taxes). amount_basis is stated on every record.', 'null when the money bag is absent; the order itself is rejected only when originalTotalPriceSet is missing.', source_path='LineItem.originalTotalSet.shopMoney | LineItem.discountedTotalSet.shopMoney'),
    'line_tax_minor': F('derived', 'Sum of LineItem.taxLines[].priceSet.shopMoney in minor units (revised records); null on order.accepted because taxes are not fixed at acceptance.', 'null when no tax lines or mixed currencies.', rule='connectors.normalize.shopify.v1: sum(taxLines.priceSet) with currency check; inputs = LineItem.taxLines evidence.'),
    'line_gross_minor': F('derived', 'line_net_minor + line_tax_minor on order.revised; null on order.accepted.', 'null when either component is null; never approximated from rounded unit prices.', rule='connectors.normalize.shopify.v1: discountedTotalSet + sum(taxLines) per line.'),
    'discount_minor': F('source', 'LineItem.totalDiscountSet per line and Order.totalDiscountsSet per order on order.revised; null on order.accepted.', 'null when absent.', source_path='LineItem.totalDiscountSet.shopMoney | Order.totalDiscountsSet.shopMoney'),
    'shipping_minor': F('source', 'Order.totalShippingPriceSet in minor units on order.revised; null on order.accepted.', 'null when absent.', source_path='Order.totalShippingPriceSet.shopMoney'),
    'agreed_version': F('source', 'ISO timestamp of acceptance (createdAt); order.accepted carries original totals, later revisions reference it.', 'Required.', source_path='Order.createdAt'),
    'cancellation_state': F('derived', '"cancelled" when cancelledAt is set (order.cancelled appended with cancelledAt as effective time), otherwise "none".', 'Never guessed from financial status.', rule='connectors.normalize.shopify.v1: cancelledAt != null -> cancelled.'),
    'updated_at': F('source', 'Order.updatedAt; also the revision suffix of order.revised identities.', 'Required.', source_path='Order.updatedAt'),
}, [
    {'event': 'order.accepted', 'tracks': ['source', 'fact'], 'rule': 'One per order from Order.createdAt with original (agreed) totals; identity "<shop>|order:<id>|accepted" is stable across re-reads so re-fetches are duplicates. No commitment track is derived until the commitment semantics of an order are confirmed with the engine owner.'},
    {'event': 'order.revised', 'tracks': ['source', 'fact'], 'rule': 'One per observed updatedAt > createdAt with current quantities/totals; intermediate edits between polls are not reconstructed.'},
    {'event': 'order.cancelled', 'tracks': ['source', 'fact'], 'rule': 'When cancelledAt is set; effective time = cancelledAt.'},
], 'Only the current revision of an order is readable; line removals and refunds are distinct (currentQuantity vs refund transactions).', 'Orders and lines')

rows['shopify.payments'] = order_row('payments', {
    'transaction_id': F('source', 'OrderTransaction gid.', 'Transaction without id/kind/status/amount/test is rejected as missing_required_field.', source_path='Order.transactions[].id'),
    'original_transaction_id': F('source', 'parentTransaction gid (capture -> authorization, refund -> sale/capture).', 'null for standalone sales; no join guessed by amount.', source_path='Order.transactions[].parentTransaction.id'),
    'order_id': F('source', 'Parent order gid.', 'Required.', source_path='Order.id'),
    'account_id': F('derived', 'Shop gid (account_ref) as the payment account namespace.', 'Required (credential check).', rule='connectors.normalize.shopify.v1: account_id = Shop.id'),
    'gateway': F('source', 'Gateway handle string (e.g. shopify_payments, bogus).', 'null when absent.', source_path='Order.transactions[].gateway'),
    'kind': F('source', 'Lowercased kind: authorization, sale, capture, void, refund.', 'Required.', source_path='Order.transactions[].kind'),
    'status': F('source', 'Lowercased status: success, failure, error, pending, awaiting_response.', 'Required; pending/awaiting_response transactions are recorded as unsupported (dead letter), never as cash.', source_path='Order.transactions[].status'),
    'amount_minor': F('source', 'amountSet.shopMoney in integer minor units; payment.authorized carries authorized_minor, payment.captured captured_minor.', 'Rejected when absent (poison payload becomes a visible dead letter).', source_path='Order.transactions[].amountSet.shopMoney.amount'),
    'currency': F('source', 'ISO code of amountSet.shopMoney.', 'Rejected when absent.', source_path='Order.transactions[].amountSet.shopMoney.currencyCode'),
    'occurred_at': F('source', 'processedAt (fallback createdAt) as effective time.', 'Falls back to order.updatedAt only when both are absent (disclosed).', source_path='Order.transactions[].processedAt'),
    'economic_effect_id': F('derived', '"shopify:transaction:<numeric id>"; shared with Shopify Payments balance transactions through sourceOrderTransactionId.', 'Always present.', rule='connectors.normalize.shopify.v1: economic_effect_id = shopify:transaction:<numericId(transaction.id)>'),
}, [
    {'event': 'payment.authorized', 'tracks': ['source', 'fact'], 'rule': 'kind AUTHORIZATION + status SUCCESS: a fact about the authorization; not a cash movement and not a capture.'},
    {'event': 'payment.captured', 'tracks': ['source', 'movement'], 'rule': 'kind SALE or CAPTURE + status SUCCESS: collected cash; test:true is carried as an explicit payload flag and never proves settlement.'},
    {'event': 'payment.failed', 'tracks': ['source', 'fact'], 'rule': 'status FAILURE/ERROR of any kind (failed earlier attempts stay visible with errorCode).'},
    {'event': 'payment.voided', 'tracks': ['source', 'fact'], 'rule': 'kind VOID + SUCCESS releases the authorization; no cash effect.'},
], 'Transactions are visible only through orders within the plan window or open phase.', 'Order transactions')

rows['shopify.fulfillments'] = order_row('fulfillments', {
    'shipment_id': F('source', 'Fulfillment gid.', 'Fulfillment without id/status/createdAt is rejected.', source_path='Order.fulfillments[].id'),
    'order_id': F('source', 'Parent order gid.', 'Required.', source_path='Order.id'),
    'line_id': F('source', 'Order line gid per fulfillment line.', 'Fulfillment without lines yields an empty lines array (flagged truncated when the nested page overflows).', source_path='Order.fulfillments[].fulfillmentLineItems.nodes[].lineItem.id'),
    'quantity': F('source', 'Decimal string per line; physical_stock_delta per line = -quantity on shipment.dispatched.', 'Required per line.', source_path='Order.fulfillments[].fulfillmentLineItems.nodes[].quantity'),
    'unit': PIECE,
    'location_id': F('source', 'Location gid.', 'null when absent.', source_path='Order.fulfillments[].location.id'),
    'carrier': F('source', 'First trackingInfo company.', 'null when no tracking info (labels alone are not handover).', source_path='Order.fulfillments[].trackingInfo[0].company'),
    'tracking_number': F('source', 'First trackingInfo number.', 'null when absent; multi-package assignment unknown.', source_path='Order.fulfillments[].trackingInfo[0].number'),
    'handover_at': F('derived', 'createdAt when status is SUCCESS (fulfillment creation = handed to carrier); inTransitAt is carried separately.', 'null while PENDING/OPEN (shipment.observed only).', rule='connectors.normalize.shopify.v1: handover_at = createdAt if status == SUCCESS else null'),
    'delivered_at': F('source', 'deliveredAt when the fulfillment reports delivery (provider assertion; a carrier scan would be independent evidence).', 'null when not delivered; no delivery inferred from time.', source_path='Order.fulfillments[].deliveredAt'),
    'state': F('source', 'Lowercased status (success, pending, open, cancelled, error, failure).', 'Required.', source_path='Order.fulfillments[].status'),
}, [
    {'event': 'shipment.observed', 'tracks': ['source', 'fact'], 'rule': 'Statuses other than SUCCESS/CANCELLED (pending/open/error/failure): observation without stock effect.'},
    {'event': 'shipment.dispatched', 'tracks': ['source', 'movement', 'reservation'], 'rule': 'Status SUCCESS: goods left stock (physical_stock_delta = -quantity per line). The reservation entry carries reservation_released = null because Shopify exposes no reservation evidence; nothing is fabricated.'},
    {'event': 'shipment.delivered', 'tracks': ['source', 'fact'], 'rule': 'deliveredAt present: delivery fact at deliveredAt; no second stock movement.'},
    {'event': 'shipment.cancelled', 'tracks': ['source', 'fact'], 'rule': 'Status CANCELLED: fact; the stock reversal is not inferred (a return/receipt must be observed).'},
], 'Reservation release quantities are unknown; multi-package line assignment is unknown.', 'Fulfillments')

rows['shopify.refunds'] = order_row('refunds', {
    'refund_id': F('source', 'Refund gid when the transaction belongs to a Refund object (refunds[].transactions), otherwise the refund transaction gid.', 'Falls back to the transaction gid (disclosed).', source_path='Order.refunds[].id (via refunds[].transactions.nodes[].id join)'),
    'original_transaction_id': F('source', 'parentTransaction gid of the refund transaction.', 'null when absent; never matched by amount.', source_path='Order.transactions[].parentTransaction.id'),
    'order_id': F('source', 'Parent order gid.', 'Required.', source_path='Order.id'),
    'amount_minor': F('source', 'amountSet.shopMoney minor units; refund.pending carries held_minor, refund.completed hold_released_minor.', 'Rejected when absent.', source_path='Order.transactions[kind=REFUND].amountSet.shopMoney.amount'),
    'currency': F('source', 'ISO code.', 'Rejected when absent.', source_path='Order.transactions[kind=REFUND].amountSet.shopMoney.currencyCode'),
    'status': F('source', 'success -> completed, pending -> pending, failure/error -> failed.', 'Other statuses are recorded as unsupported.', source_path='Order.transactions[kind=REFUND].status'),
    'destination': F('derived', '"gift_card" when gateway == gift_card, otherwise "original_payment_method"; store-credit destinations are not distinguished by the pinned fields.', 'Defaults to original_payment_method with the gateway disclosed.', rule='connectors.normalize.shopify.v1: destination from transaction.gateway'),
    'economic_effect_id': F('derived', '"shopify:transaction:<numeric id>" shared with the Shopify Payments ledger REFUND posting (sourceOrderTransactionId).', 'Always present.', rule='connectors.normalize.shopify.v1: economic_effect_id = shopify:transaction:<numericId(refund transaction id)>'),
}, [
    {'event': 'refund.pending', 'tracks': ['source', 'reservation'], 'rule': 'REFUND + PENDING: funds held (held_minor); no cash movement yet.'},
    {'event': 'refund.completed', 'tracks': ['source', 'movement', 'reservation'], 'rule': 'REFUND + SUCCESS: cash out (amount_minor) and hold released; deduplicated with the ledger refund by economic_effect_id.'},
    {'event': 'refund.failed', 'tracks': ['source', 'fact'], 'rule': 'REFUND + FAILURE/ERROR: fact only.'},
    {'event': 'refund.reversed', 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'Shopify exposes no refund reversal object on OrderTransaction; a reversal would appear as a new transaction and is not inferred.'},
], 'Refund line restock flags are not receipts; receipts come from reverse fulfillment order dispositions.', 'Refund transactions')

rows['shopify.returns'] = order_row('returns', {
    'return_id': F('source', 'Return gid.', 'Return without id/status is rejected.', source_path='Order.returns.nodes[].id'),
    'order_id': F('source', 'Parent order gid.', 'Required.', source_path='Order.id'),
    'line_id': F('source', 'Order line gid through fulfillmentLineItem.lineItem.', 'null per line when the return line has no fulfillment line link (unfulfilled line).', source_path='Order.returns.nodes[].returnLineItems.nodes[].fulfillmentLineItem.lineItem.id'),
    'quantity': F('source', 'Decimal string per return line; record total = sum of lines.', 'Required per line.', source_path='Order.returns.nodes[].returnLineItems.nodes[].quantity'),
    'unit': PIECE,
    'state': F('source', 'Lowercased Return.status (requested, open, closed, declined, canceled).', 'Required.', source_path='Order.returns.nodes[].status'),
    'reverse_shipment_id': F('missing', 'Would be ReverseDelivery.id.', 'Reverse logistics questions stay partial: no reverse shipment link is claimed.', reason='ReverseDelivery objects are not part of the pinned query subset; their availability in the merchant workflow was not verifiable offline and is a SOURCE-01 live proof item.'),
}, [
    {'event': 'return.approved', 'tracks': ['source', 'fact'], 'rule': 'Return.status OPEN (approved return in progress); effective time = Order.updatedAt (disclosed: Return exposes no own timestamp in the selected fields).'},
    {'event': 'return.revised', 'tracks': ['source', 'fact'], 'rule': 'Return.status REQUESTED or CLOSED (workflow state change), identity "<shop>|ret:<id>|<status>".'},
    {'event': 'return.cancelled', 'tracks': ['source', 'fact'], 'rule': 'Return.status CANCELED or DECLINED.'},
], 'Return intent is not receipt; expected credit is unknown until a refund transaction exists.', 'Returns')

rows['shopify.receipts'] = order_row('receipts', {
    'receipt_id': F('source', 'ReverseFulfillmentOrderDisposition gid.', 'Dispositions without id are skipped as rejected.', source_path='Order.returns.nodes[].reverseFulfillmentOrders.nodes[].lineItems.nodes[].dispositions[].id'),
    'return_id': F('source', 'Return gid.', 'Required.', source_path='Order.returns.nodes[].id'),
    'line_id': F('source', 'Order line gid through the reverse fulfillment order line.', 'null when the link is absent.', source_path='...reverseFulfillmentOrders.nodes[].lineItems.nodes[].fulfillmentLineItem.lineItem.id'),
    'location_id': F('source', 'Location gid of the disposition.', 'null when absent.', source_path='...dispositions[].location.id'),
    'quantity': F('source', 'Decimal string.', 'Required.', source_path='...dispositions[].quantity'),
    'unit': PIECE,
    'disposition': F('source', 'Lowercased type: processing_required, restocked, not_restocked, missing.', 'Required.', source_path='...dispositions[].type'),
    'physical_delta': F('derived', 'PROCESSING_REQUIRED: +quantity; RESTOCKED without a prior PROCESSING_REQUIRED on the same line: +quantity (counted once as the physical receipt); RESTOCKED after PROCESSING_REQUIRED: 0; NOT_RESTOCKED/MISSING: 0.', 'Never derived from a return request or refund restock flag.', rule='connectors.normalize.shopify.v1 disposition rule (restock_basis disclosed on each record).'),
    'quarantine_delta': F('derived', 'PROCESSING_REQUIRED: +quantity; RESTOCKED after PROCESSING_REQUIRED: -quantity; otherwise 0.', 'Conservation: receiving into quarantine increases physical and quarantine; restocking releases quarantine without a second physical receipt.', rule='connectors.normalize.shopify.v1 disposition rule.'),
    'occurred_at': F('derived', 'Order.updatedAt (dispositions expose no timestamp in the pinned subset); effective_time_basis is stated on the record.', 'Disclosed approximation; recorded_at is the import time.', rule='connectors.normalize.shopify.v1: occurred_at = Order.updatedAt'),
}, [
    {'event': 'return.received', 'tracks': ['source', 'movement'], 'rule': 'Disposition PROCESSING_REQUIRED: goods received into quarantine (physical +q, quarantine +q).'},
    {'event': 'return.restocked', 'tracks': ['source', 'movement'], 'rule': 'Disposition RESTOCKED: quarantine released (or counted once as the physical receipt when no prior PROCESSING_REQUIRED exists).'},
    {'event': 'return.disposition_observed', 'tracks': ['source', 'fact'], 'rule': 'NOT_RESTOCKED / MISSING: fact only; MISSING is not received.'},
], 'Dispositions prove merchant processing decisions, not checked SKU-level receipt.', 'Reverse fulfillment dispositions')

rows['shopify.stock'] = {
    'row_id': 'shopify.stock', 'source_revision': SOURCE_REVISION, 'input_resources': ['InventoryItem', 'InventoryLevel', 'InventoryQuantity'], 'grants': ['read_inventory', 'read_products'],
    'identity_rule': 'Account scope = Shop.id. Record identity = "stock:<InventoryItem gid>@<Location gid>"; provider_event_id = "<shop>|inv:<InventoryLevel numeric id>|<updatedAt>" so unchanged levels are duplicates and changed levels are new snapshots.',
    'coverage_rule': 'Snapshot-only: the backfill reads all current levels once (history_kind snapshot_only); incremental reads items with updated_at >= floor; differences between snapshots never prove a movement cause.',
    'retention': RETENTION,
    'fields': {
        'item_id': F('source', 'InventoryItem gid.', 'Required.', source_path='inventoryItems.nodes[].id'),
        'location_id': F('source', 'Location gid.', 'Level without location is rejected.', source_path='inventoryItems.nodes[].inventoryLevels.nodes[].location.id'),
        'unit': PIECE,
        'observed_at': F('source', 'InventoryLevel.updatedAt as the snapshot time.', 'Rejected when absent.', source_path='inventoryItems.nodes[].inventoryLevels.nodes[].updatedAt'),
        'basis': F('derived', 'Constant "shopify_named_quantity_states": named states are read as published; available is already net of unavailable states and is never reduced again.', 'Constant.', rule='connectors.normalize.shopify.v1: basis constant; see CONNECTOR-CAPABILITIES finding 1.'),
        'physical': F('source', 'quantities[name=on_hand].quantity as decimal string.', 'null when the state is not returned (never zero).', source_path='inventoryLevels.nodes[].quantities[name=on_hand].quantity'),
        'available': F('source', 'quantities[name=available].', 'null when absent.', source_path='inventoryLevels.nodes[].quantities[name=available].quantity'),
        'committed': F('source', 'quantities[name=committed].', 'null when absent.', source_path='inventoryLevels.nodes[].quantities[name=committed].quantity'),
        'reserved': F('source', 'quantities[name=reserved].', 'null when absent.', source_path='inventoryLevels.nodes[].quantities[name=reserved].quantity'),
        'damaged': F('source', 'quantities[name=damaged].', 'null when absent.', source_path='inventoryLevels.nodes[].quantities[name=damaged].quantity'),
        'safety_stock': F('source', 'quantities[name=safety_stock].', 'null when absent.', source_path='inventoryLevels.nodes[].quantities[name=safety_stock].quantity'),
        'quality_control': F('source', 'quantities[name=quality_control].', 'null when absent.', source_path='inventoryLevels.nodes[].quantities[name=quality_control].quantity'),
        'incoming': F('source', 'quantities[name=incoming]; not on hand.', 'null when absent.', source_path='inventoryLevels.nodes[].quantities[name=incoming].quantity'),
    },
    'event_rules': [
        {'event': 'inventory.snapshot', 'tracks': ['source', 'fact'], 'rule': 'One snapshot per (item, location, updatedAt); supersedes earlier snapshots in projections; never a movement.'},
        {'event': 'inventory.adjustment_observed', 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'Inventory adjustment history (reasons/ledger) is not part of the pinned query subset; a snapshot difference is not an adjustment observation.'},
    ],
    'synchronization': {
        'initial_import': 'BlackboxInventoryItems (first=25, nested inventoryLevels first=10 with eight named quantity states) over all items, Relay pagination; no provider count (totals unknown).',
        'cursor': 'Incremental query updated_at:>=floor on InventoryItem with 900 s overlap; page cursor = Relay endCursor; floor never advances past now.',
        'reconciliation': 'Every 24 h (bounded to 24 h after sleep/wake) a full re-read of changed items; identical levels are duplicates.',
        'deduplication': 'provider_event_id includes the level updatedAt; identical content = duplicate delivery; different content under the same updatedAt = conflict (review case).',
        'freshness': 'Poll every 900 s (300 s to 6 h, jitter 60 s). A successful empty poll advances last_successful_check_at only.',
        'modes': {'local_standalone': {'status': 'partial', 'methods': ['polling'], 'schedule': 'Poll every 900 s (300 s-6 h, jitter 60 s); reconciliation daily.', 'history_limit': 'No stock history: only current levels (snapshot_only).', 'authentication': AUTH, 'recovery': RECOVERY_POLL, 'limitations': 'Snapshot-only; named states depend on location/app configuration; levels beyond 10 locations per item are flagged.', 'reason': 'Current levels are readable by polling; movement history is not, so the capability stays partial.'}, 'local_gateway': GATEWAY, 'public_server': PUBLIC},
    },
    'import_readiness': readiness(
        'InventoryLevel.updatedAt is the snapshot time; a date plan does not apply to stock (there is no stock history) and the plan window is disclosed as not applicable for this capability.',
        'Only the current state is available (history_kind snapshot_only); no earlier levels are reconstructed.',
        'All items/locations are read; related orders are not traversed from stock.',
        'The first snapshot is the opening stock as of its updatedAt; it is a fact, not a movement.',
        'loaded = inventory items fetched; committed = distinct (item, location) records with a new snapshot; totals unknown (no provider count) so counts and phase are shown, no percentage.',
        'Stock questions are ready for items with a snapshot not older than the schedule; partial for items without named states (null); free stock derivations require physical/committed/reserved/damaged/safety_stock/quality_control to be present.',
        'healthy after a complete poll within interval + jitter; degraded on missing read_inventory; stale snapshots are reported with their observed_at.',
        'Not applicable beyond re-reading current levels; a history expansion creates no older snapshots.',
        'Only gids, SKU strings and integer quantities; no personal data.'),
}

rows['shopify.allocations'] = {
    'row_id': 'shopify.allocations', 'source_revision': SOURCE_REVISION, 'input_resources': ['FulfillmentOrder', 'FulfillmentOrderLineItem', 'FulfillmentOrderAssignedLocation'], 'grants': ['read_merchant_managed_fulfillment_orders', 'read_assigned_fulfillment_orders'],
    'identity_rule': 'Account scope = Shop.id. Record identity = "allocation:<FulfillmentOrder gid>"; provider_event_id = "<shop>|fo:<numeric id>|<updatedAt>".',
    'coverage_rule': 'Fulfillment orders with updated_at in the plan window / since the incremental floor; the assignment is planned work, never a reservation (is_stock_reservation = false on every record).',
    'retention': RETENTION,
    'fields': {
        'allocation_id': F('source', 'FulfillmentOrder gid (record) with per-line FulfillmentOrderLineItem gids.', 'Required.', source_path='fulfillmentOrders.nodes[].id / lineItems.nodes[].id'),
        'order_id': F('source', 'Order gid.', 'Required.', source_path='fulfillmentOrders.nodes[].order.id'),
        'line_id': F('source', 'Order line gid.', 'Required per line.', source_path='fulfillmentOrders.nodes[].lineItems.nodes[].lineItem.id'),
        'item_id': F('source', 'InventoryItem gid.', 'null when absent.', source_path='fulfillmentOrders.nodes[].lineItems.nodes[].inventoryItemId'),
        'location_id': F('source', 'Assigned location gid.', 'null when unassigned.', source_path='fulfillmentOrders.nodes[].assignedLocation.location.id'),
        'quantity': F('source', 'remainingQuantity (outstanding work) as decimal string; total_quantity carried separately.', 'Required.', source_path='fulfillmentOrders.nodes[].lineItems.nodes[].remainingQuantity'),
        'unit': PIECE,
        'status': F('derived', 'completed when remainingQuantity = 0, otherwise the lowercased FulfillmentOrder status (open, in_progress, on_hold, scheduled, cancelled...).', 'Required.', rule='connectors.normalize.shopify.v1: status from remainingQuantity/status'),
        'policy_version': F('derived', 'Constant "shopify-fulfillment-order-assignment.v1": declares that the allocation is the provider assignment, not a workspace allocation policy.', 'Constant.', rule='connectors.normalize.shopify.v1 policy constant'),
        'evidence_id': F('derived', 'journal_evidence id of the raw FulfillmentOrder payload stored with the source entry.', 'Always present.', rule='connectors.ingest.v1: evidence_refs[0] of the source entry'),
    },
    'event_rules': [
        {'event': 'inventory.reserved', 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'Shopify exposes no reservation evidence; a fulfillment-order location assignment is not a stock reservation (CONNECTOR-CAPABILITIES finding 1). Reservations must come from a generic producer.'},
        {'event': 'inventory.reservation_released', 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'No reservation is recorded from Shopify, so no release is recorded either.'},
        {'event': 'allocation.revised', 'tracks': ['source', 'fact'], 'rule': 'One fact per observed FulfillmentOrder updatedAt with remaining quantities per line; no reservation track is derived.'},
    ],
    'synchronization': {
        'initial_import': 'BlackboxFulfillmentOrders (first=20, lineItems first=25) with updated_at:>=requested_from; Relay pagination; no provider count.',
        'cursor': 'Incremental updated_at:>=floor with 900 s overlap; Relay endCursor within a run.',
        'reconciliation': 'Daily (bounded after sleep/wake) re-read of updated_at within the window.',
        'deduplication': 'provider_event_id includes updatedAt; identical content duplicates, differing content conflicts.',
        'freshness': 'Poll every 900 s (300 s-6 h, jitter 60 s).',
        'modes': {'local_standalone': {'status': 'partial', 'methods': ['polling'], 'schedule': 'Poll every 900 s; reconciliation daily.', 'history_limit': 'Fulfillment orders as exposed by the API; closed fulfillment orders older than the window are not re-read.', 'authentication': AUTH, 'recovery': RECOVERY_POLL, 'limitations': 'Planned work only; no reservation semantics; line pages beyond 25 are flagged.', 'reason': 'Polling works for planned fulfillment work; reservation evidence is missing, so the capability is partial.'}, 'local_gateway': GATEWAY, 'public_server': PUBLIC},
    },
    'import_readiness': readiness(
        'FulfillmentOrder.updatedAt selects both the import window and incremental reads (no created_at filter is used).',
        'Current assignments only; earlier assignment changes are not reconstructed.',
        'Open fulfillment orders of older orders are included through the updated_at window only; related orders are read by shopify.orders.',
        'Not applicable: an assignment is not an opening reservation balance.',
        'loaded = fulfillment orders fetched; committed = distinct fulfillment orders with a new fact; totals unknown.',
        'Allocation questions that need reservations are blocked/partial for Shopify-only workspaces (explicit missing fields); questions about outstanding fulfillment work are ready after a complete poll.',
        'healthy after a complete poll within interval + jitter; degraded on missing fulfillment-order scopes.',
        'Re-reading a wider updated_at window; no older reservations appear.',
        'Only gids and quantities.'),
}

FIN_READ = dict(
    historical='Balance transactions and payouts as far back as the account exposes them; the exact depth is not verifiable offline and is recorded from the authorized account (blocked_external until then).',
    opening='Account balance snapshots (positions) are the opening state as of the poll time; they are never summed with ledger movements.',
    handling='Only gids, amounts, types, statuses and timestamps; no bank account numbers (bankAccounts is not queried).',
)

def fin_row(dataset, resources, grants, identity, coverage, fields, events, sync, time_selection, open_related, progress, ready, health, expansion):
    return {'row_id': f'shopify_payments.{dataset}', 'source_revision': SOURCE_REVISION, 'input_resources': resources, 'grants': grants, 'identity_rule': identity, 'coverage_rule': coverage, 'retention': RETENTION, 'fields': fields, 'event_rules': events, 'synchronization': sync,
            'import_readiness': readiness(time_selection, FIN_READ['historical'], open_related, FIN_READ['opening'], progress, ready, health, expansion, FIN_READ['handling'])}

LEDGER_FIELDS = {
    'ledger_entry_id': F('source', 'ShopifyPaymentsBalanceTransaction gid.', 'Rejected when absent.', source_path='shopifyPaymentsAccount.balanceTransactions.nodes[].id'),
    'account_id': F('source', 'ShopifyPaymentsAccount gid.', 'Blocked when the account is not active.', source_path='shopifyPaymentsAccount.id'),
    'source_transaction_id': F('source', 'sourceOrderTransactionId rendered as gid://shopify/OrderTransaction/<id>.', 'null for adjustments/transfers (no forced link).', source_path='balanceTransactions.nodes[].sourceOrderTransactionId'),
    'order_link': F('source', 'associatedOrder.id.', 'null when absent; never guessed from equal amounts.', source_path='balanceTransactions.nodes[].associatedOrder.id'),
    'payout_id': F('source', 'associatedPayout.id with its status.', 'null while unsettled (residual stays visible).', source_path='balanceTransactions.nodes[].associatedPayout.id'),
    'posting_type': F('source', 'Lowercased type (charge, refund, dispute, dispute_reversal, adjustment, transfer, ...).', 'Rejected when absent; unknown types are still recorded as ledger postings with their type string.', source_path='balanceTransactions.nodes[].type'),
    'gross_minor': F('source', 'amount in minor units (sign as published).', 'Rejected when absent.', source_path='balanceTransactions.nodes[].amount'),
    'fee_minor': F('source', 'fee in minor units.', 'Rejected when absent.', source_path='balanceTransactions.nodes[].fee'),
    'net_minor': F('source', 'net in minor units (= gross - fee as published).', 'Rejected when absent.', source_path='balanceTransactions.nodes[].net'),
    'currency': F('source', 'net.currencyCode.', 'Rejected when absent.', source_path='balanceTransactions.nodes[].net.currencyCode'),
    'effective_time': F('source', 'transactionDate.', 'Rejected when absent.', source_path='balanceTransactions.nodes[].transactionDate'),
}
rows['shopify_payments.provider_ledger'] = fin_row('provider_ledger', ['ShopifyPaymentsAccount', 'ShopifyPaymentsBalanceTransaction'], ['read_shopify_payments_payouts (view_payouts)'],
    'Account scope = ShopifyPaymentsAccount.id (compared on every check). provider_event_id = "<shop>|bt:<numeric id>|posted" plus "|fee" for the fee breakdown; economic_effect_id = shopify:transaction:<sourceOrderTransactionId> when present, otherwise shopify_payments:balance_transaction:<id>.',
    'Ledger entries with transactionDate in the plan window / since the floor; unsettled residuals (no payout) stay visible; sign/type mapping is versioned (connectors.normalize.shopify_payments.v1).',
    LEDGER_FIELDS, [
        {'event': 'provider.ledger_posted', 'tracks': ['source', 'movement'], 'rule': 'Every balance transaction: movement on the provider balance with gross/fee/net; test flag explicit.'},
        {'event': 'payment.fee_booked', 'tracks': ['source', 'movement'], 'rule': 'For type CHARGE with fee != 0: the fee breakdown of the same ledger entry (included_in_ledger_entry = true, economic_effect_id = <ledger effect>:fee); reducers must not add it to the net movement again.'},
    ], finance_sync('balanceTransactions', 'processed_at', 'Whether the balanceTransactions connection accepts a processed_at query filter was not verifiable offline (the fixture implements it); if the live API rejects it the adapter falls back to full pagination with client-side filtering, recorded as a limitation at SOURCE-01 time.'),
    'transactionDate (processed_at) selects records; payout membership is an attribute, not a time filter.',
    'Entries linked to orders outside the plan window are kept (their order link is an optional attribute); no order traversal from the ledger.',
    'loaded = balance transactions fetched; committed = distinct ledger entries with new journal entries; totals unknown.',
    'Provider ledger questions are ready after a complete backfill and a current poll; partial when sourceOrderTransactionId links are absent for charges in scope.',
    'healthy after a complete poll within 1800 s + jitter; degraded on missing read_shopify_payments_payouts or inactive account.',
    'Wider processed_at window; duplicates deduplicated by id.')

rows['shopify_payments.refunds'] = fin_row('refunds', ['ShopifyPaymentsAccount', 'ShopifyPaymentsBalanceTransaction'], ['read_shopify_payments_payouts (view_payouts)'],
    'provider_event_id = "<shop>|bt:<numeric id>|refund"; record id refund:ledger:<id>; economic_effect_id = shopify:transaction:<sourceOrderTransactionId> (shared with shopify.refunds so one refund is never two debits).',
    'Balance transactions of type REFUND in the window; pending/failed refunds are not visible in the ledger (see shopify.refunds).',
    {
        'refund_id': F('derived', '"ledger:<balance transaction id>"; the shop Refund gid is reachable through the shared economic_effect_id.', 'Always present.', rule='connectors.normalize.shopify_payments.v1: refund_id = ledger:<id>'),
        'original_transaction_id': F('source', 'sourceOrderTransactionId as OrderTransaction gid.', 'null when absent (refund not linkable; kept as ledger posting only).', source_path='balanceTransactions.nodes[type=REFUND].sourceOrderTransactionId'),
        'order_id': F('source', 'associatedOrder.id.', 'null when absent.', source_path='balanceTransactions.nodes[type=REFUND].associatedOrder.id'),
        'amount_minor': F('source', 'abs(amount) in minor units.', 'Rejected when absent.', source_path='balanceTransactions.nodes[type=REFUND].amount'),
        'currency': F('source', 'amount.currencyCode.', 'Rejected when absent.', source_path='balanceTransactions.nodes[type=REFUND].amount.currencyCode'),
        'status': F('derived', 'Constant "completed": a REFUND ledger posting is a settled provider movement.', 'Constant.', rule='connectors.normalize.shopify_payments.v1: REFUND posting -> completed'),
        'destination': F('derived', 'Constant "original_payment_method" (the ledger refunds the card/payment method).', 'Constant; gift-card refunds never appear in the Shopify Payments ledger.', rule='connectors.normalize.shopify_payments.v1 destination constant'),
        'economic_effect_id': F('derived', 'shopify:transaction:<sourceOrderTransactionId> or the balance transaction identity when unlinked.', 'Always present.', rule='connectors.normalize.shopify_payments.v1 economic identity'),
    }, [
        {'event': 'refund.pending', 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'The provider ledger only shows settled postings; pending refunds come from shopify.refunds.'},
        {'event': 'refund.completed', 'tracks': ['source', 'movement', 'reservation'], 'rule': 'REFUND posting: cash out on the provider balance; deduplicated with the shop refund by economic_effect_id.'},
        {'event': 'refund.failed', 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'Failed refunds never post to the ledger; see shopify.refunds.'},
        {'event': 'refund.reversed', 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'No refund reversal posting type is verifiable in the pinned enum offline; unknown types are kept as provider.ledger_posted with their type string.'},
    ], finance_sync('balanceTransactions', 'processed_at', 'Same connection as provider_ledger; see its limitations.'),
    'transactionDate of the REFUND posting.', 'The refunded order is an optional link; no traversal.', 'Counted within the ledger poll (same provider query).',
    'Refund cash questions are ready when both shop and ledger refunds are current; partial when ledger postings lack sourceOrderTransactionId.', 'Shared with provider_ledger.', 'Shared with provider_ledger.')

rows['shopify_payments.payouts'] = fin_row('payouts', ['ShopifyPaymentsAccount', 'ShopifyPaymentsPayout', 'ShopifyPaymentsPayoutSummary'], ['read_shopify_payments_payouts (view_payouts)'],
    'provider_event_id = "<shop>|payout:<numeric id>|<status>" so each status transition is a new observation; record id payout:<gid>.',
    'Payouts with issuedAt in the plan window / since the floor; status transitions are observed at polls (intermediate transitions between polls are not reconstructed).',
    {
        'payout_id': F('source', 'ShopifyPaymentsPayout gid.', 'Rejected when absent.', source_path='shopifyPaymentsAccount.payouts.nodes[].id'),
        'account_id': F('source', 'ShopifyPaymentsAccount gid.', 'Blocked when the account is inactive.', source_path='shopifyPaymentsAccount.id'),
        'status': F('source', 'Lowercased status: scheduled, in_transit, paid, failed, canceled.', 'Rejected when absent.', source_path='payouts.nodes[].status'),
        'direction': F('source', 'transactionType DEPOSIT -> to_bank, WITHDRAWAL -> from_bank.', 'Defaults to to_bank only when transactionType is DEPOSIT; otherwise from_bank.', source_path='payouts.nodes[].transactionType'),
        'amount_minor': F('source', 'net.amount in minor units.', 'Rejected when absent.', source_path='payouts.nodes[].net.amount'),
        'currency': F('source', 'net.currencyCode.', 'Rejected when absent.', source_path='payouts.nodes[].net.currencyCode'),
        'issued_at': F('source', 'issuedAt (effective time of the transfer order).', 'Rejected when absent.', source_path='payouts.nodes[].issuedAt'),
        'trace_reference': F('missing', 'Would be an external bank trace id.', 'Bank matching must use amount/date/currency candidates from bank_csv and stays explicit (bank.match_recorded), never automatic.', reason='No bank trace reference field is part of the verified 2026-10 payout selection (externalTraceId could not be confirmed offline); recorded as a SOURCE-01 live proof item.'),
        'ledger_membership': F('derived', 'Derived from balance transactions whose associatedPayout.id equals the payout (recorded on the ledger entries); the payout record itself carries null and a fee_summary from ShopifyPaymentsPayoutSummary.', 'null until the ledger poll links entries; gross-to-net explanation stays partial while membership is incomplete.', rule='connectors.normalize.shopify_payments.v1: membership = ledger entries with associatedPayout.id = payout_id'),
        'reversal_id': F('missing', 'Would reference a reversing payout.', 'Reversed transfers are visible only as FAILED/CANCELED payouts (payout.failed) or new ledger postings.', reason='No reversal link exists on ShopifyPaymentsPayout in the pinned schema.'),
    }, [
        {'event': 'payout.announced', 'tracks': ['source', 'commitment'], 'rule': 'Status SCHEDULED: the provider commits to transfer; no asset moved yet.'},
        {'event': 'payout.sent', 'tracks': ['source', 'movement'], 'rule': 'Status IN_TRANSIT or PAID: funds in transit / provider asserts paid; bank credit must be confirmed independently (bank_csv).'},
        {'event': 'payout.failed', 'tracks': ['source', 'fact'], 'rule': 'Status FAILED or CANCELED (state carried).'},
        {'event': 'payout.reversed', 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'No payout reversal object/state exists in the pinned schema; a reversal would appear as a new ledger posting.'},
    ], finance_sync('payouts', 'issued_at', 'Payout status is a provider assertion; transitions between polls are not reconstructed.'),
    'issuedAt selects payouts.', 'Unsettled payouts (SCHEDULED/IN_TRANSIT) before the window are included through the open-items phase of the plan.', 'loaded = payouts fetched; committed = distinct payouts with new observations; totals unknown.',
    'Payout questions are ready after a complete backfill and current poll; bank-settlement answers stay partial until bank_csv evidence matches.', 'healthy after a complete poll; degraded on missing scope/inactive account.', 'Wider issued_at window; status transitions already observed are duplicates.')

rows['shopify_payments.positions'] = fin_row('positions', ['ShopifyPaymentsAccount'], ['read_shopify_payments_payouts (view_payouts)'],
    'provider_event_id = "<shop>|balance:<account numeric id>|<currency>|<observed_at>"; record id position:<account>:<currency>.',
    'One snapshot per poll per currency; snapshots supersede and are never summed; only the total balance is covered (coverage = total_balance_only).',
    {
        'account_id': F('source', 'ShopifyPaymentsAccount gid.', 'Blocked when inactive.', source_path='shopifyPaymentsAccount.id'),
        'currency': F('source', 'balance[].currencyCode.', 'Rejected when absent.', source_path='shopifyPaymentsAccount.balance[].currencyCode'),
        'observed_at': F('derived', 'Poll request time (the balance field has no as-of timestamp).', 'Always present; disclosed as poll time.', rule='connectors.normalize.shopify_payments.v1: observed_at = request time'),
        'total_minor': F('source', 'balance[].amount in minor units.', 'Rejected when absent.', source_path='shopifyPaymentsAccount.balance[].amount'),
        'processing_minor': F('missing', 'Not published.', 'Balance breakdown questions stay partial/unknown.', reason='ShopifyPaymentsAccount exposes one total balance per currency; processing/available/held components are not established by this field (CONNECTOR-CAPABILITIES finding 3).'),
        'available_minor': F('missing', 'Not published.', 'Unknown, never derived from the total.', reason='See processing_minor.'),
        'held_minor': F('missing', 'Not published.', 'Unknown.', reason='See processing_minor; no hold objects exist.'),
        'coverage': F('derived', 'Constant "total_balance_only".', 'Constant.', rule='connectors.normalize.shopify_payments.v1 coverage constant'),
    }, [{'event': 'provider.balance_observed', 'tracks': ['source', 'fact'], 'rule': 'One snapshot per poll and currency; supersedes earlier snapshots.'}],
    {**finance_sync('balance', 'poll time', 'Only the total balance is exposed.'), 'initial_import': 'One BlackboxPaymentsAccount read (balance per currency) at backfill; no history exists.', 'cursor': 'No provider cursor; every poll records a new snapshot (identity includes observed_at).', 'reconciliation': 'Not applicable beyond the next snapshot.'},
    'Poll time (no as-of time is published).', 'Not applicable.', 'loaded = currencies read; committed = snapshots; totals known (number of currencies).',
    'Provider position questions are partial by construction (components unknown); the total is ready after the first snapshot.', 'healthy after a snapshot within 1800 s + jitter.', 'Not applicable.')

rows['shopify_payments.holds'] = {
    'row_id': 'shopify_payments.holds', 'source_revision': SOURCE_REVISION, 'input_resources': ['ShopifyPaymentsAccount (inspected; no hold object exists)'], 'grants': [],
    'identity_rule': 'Not applicable: no provider object carries a hold identity.', 'coverage_rule': 'Unsupported: no holds, reserves or release promises are readable; answers depending on holds stay unknown unless a generic producer supplies them.',
    'retention': RETENTION,
    'fields': {name: F('missing', 'Not published.', 'Hold/availability questions remain unknown; the generic producer may supply holds.', reason='Shopify Payments exposes no hold/reserve/release-promise objects in the 2026-10 schema (only a total balance; CONNECTOR-CAPABILITIES finding 3).') for name in DATASETS['holds']['required_fields']},
    'event_rules': [{'event': e, 'tracks': [], 'rule': 'Not emitted.', 'unsupported_reason': 'No provider object for holds; see fields.'} for e in DATASETS['holds']['journal_event_families']],
    'synchronization': {'initial_import': 'None: the capability has no provider resource; the worker records next_check_reason "Shopify Payments exposes no hold objects; nothing to poll."', 'cursor': 'None (no resource).', 'reconciliation': 'None (no resource).', 'deduplication': 'Not applicable.', 'freshness': 'Not applicable; the Sources page shows the capability as unsupported with this reason.',
        'modes': {'local_standalone': {'status': 'unsupported', 'methods': [], 'schedule': 'none', 'history_limit': 'none', 'authentication': 'none', 'recovery': 'none', 'limitations': 'No hold objects exist at the provider.', 'reason': 'Shopify Payments publishes no holds/reserves/release promises; the capability is declared unsupported until a verified source exists (generic producer or a future provider report).'}, 'local_gateway': GATEWAY, 'public_server': PUBLIC}},
    'import_readiness': readiness('Not applicable (no resource).', 'Not available.', 'Not applicable.', 'Not applicable; held balance components are unknown.', 'No run is created; the capability shows unsupported instead of counters.', 'Questions requiring holds are blocked/unknown for Shopify-only workspaces and say so.', 'Health shows unsupported with the reason; no stale/overdue state is derived for it.', 'Not applicable.', 'No data is read.'),
}

rows['shopify_payments.disputes'] = fin_row('disputes', ['ShopifyPaymentsAccount', 'ShopifyPaymentsDispute', 'ShopifyPaymentsBalanceTransaction'], ['read_shopify_payments_disputes', 'read_shopify_payments_payouts (view_payouts) for the booked debit/reversal postings'],
    'provider_event_id = "<shop>|dispute:<numeric id>|<status>" for case lifecycle and "<shop>|bt:<numeric id>|dispute|dispute_reversal" for booked postings; record ids dispute:<gid> and dispute-posting:<ledger gid>.',
    'Disputes with initiatedAt in the window / since the floor plus ledger postings of type DISPUTE/DISPUTE_REVERSAL from the ledger poll; original transaction linkage is only through the ledger posting (sourceOrderTransactionId), the dispute object links an order only.',
    {
        'dispute_id': F('source', 'ShopifyPaymentsDispute gid (postings carry it from sourceId when present).', 'Rejected when absent.', source_path='shopifyPaymentsAccount.disputes.nodes[].id'),
        'original_transaction_id': F('missing', 'Would be the disputed OrderTransaction.', 'With multiple captures on an order the link is ambiguous and stays null on the dispute record; the booked posting carries sourceOrderTransactionId when published.', reason='ShopifyPaymentsDispute exposes order, not the original transaction (CONNECTOR-CAPABILITIES finding 3); only the ledger posting may carry sourceOrderTransactionId.'),
        'order_id': F('source', 'order.id.', 'null when absent.', source_path='disputes.nodes[].order.id'),
        'amount_minor': F('source', 'amount in minor units.', 'Rejected when absent.', source_path='disputes.nodes[].amount'),
        'currency': F('source', 'amount.currencyCode.', 'Rejected when absent.', source_path='disputes.nodes[].amount.currencyCode'),
        'state': F('source', 'Lowercased status: needs_response, under_review, won, lost, accepted, charge_refunded.', 'Rejected when absent.', source_path='disputes.nodes[].status'),
        'debit_posting_id': F('source', 'Balance transaction gid of type DISPUTE (on chargeback.debit_posted).', 'null on the dispute record until the ledger posting is observed.', source_path='balanceTransactions.nodes[type=DISPUTE].id'),
        'debit_minor': F('source', 'abs(net) of the DISPUTE posting.', 'null until observed.', source_path='balanceTransactions.nodes[type=DISPUTE].net'),
        'reversal_minor': F('source', 'abs(net) of the DISPUTE_REVERSAL posting.', 'null until observed.', source_path='balanceTransactions.nodes[type=DISPUTE_REVERSAL].net'),
        'evidence_id': F('derived', 'journal_evidence id of the raw dispute/posting payload.', 'Always present.', rule='connectors.ingest.v1: evidence_refs[0]'),
    }, [
        {'event': 'dispute.opened', 'tracks': ['source', 'fact'], 'rule': 'Status NEEDS_RESPONSE or UNDER_REVIEW: risk flag at initiatedAt; no money effect.'},
        {'event': 'dispute.resolved', 'tracks': ['source', 'fact'], 'rule': 'Status WON/LOST/ACCEPTED/CHARGE_REFUNDED at finalizedOn (fallback initiatedAt, disclosed).'},
        {'event': 'chargeback.debit_posted', 'tracks': ['source', 'movement'], 'rule': 'Ledger posting type DISPUTE: booked debit (debit_minor) on the provider balance. The exact ShopifyPaymentsTransactionType enum values are a live proof item (not verifiable offline).'},
        {'event': 'chargeback.reversed', 'tracks': ['source', 'movement'], 'rule': 'Ledger posting type DISPUTE_REVERSAL: booked reversal (reversal_minor).'},
    ], finance_sync('disputes', 'initiated_at', 'Dispute-to-transaction linkage is ambiguous with multiple captures; booked postings depend on the ledger poll and the (offline-unverified) enum values DISPUTE/DISPUTE_REVERSAL.'),
    'initiatedAt selects dispute cases; finalizedOn is the resolution time; postings use transactionDate.', 'Open disputes initiated before the window are included through the plan open-items phase; the disputed order is an optional link.', 'loaded = disputes fetched; committed = distinct cases/postings with new entries; totals unknown.',
    'Dispute questions are ready for case status after a complete poll; booked debit/reversal answers are partial until the matching ledger postings are observed.', 'healthy after a complete poll; degraded on missing read_shopify_payments_disputes.', 'Wider initiated_at window; status transitions already observed are duplicates.')

for row_id, mapping in rows.items():
    (OUT / f'{row_id}.json').write_text(json.dumps(mapping, indent=2, ensure_ascii=False) + '\n')
print(f'wrote {len(rows)} mapping artifacts to {OUT}')
