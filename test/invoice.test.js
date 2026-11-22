const assert = require('node:assert/strict');
const test = require('node:test');

const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function discountedOrder() {
  const items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ];
  const coupon = 'SAVE10';
  const { subtotal, discount, tax, total } = pricing.computeTotals(items, coupon);
  return { id: 1, items, coupon, subtotal, discount, tax, total };
}

test('checkout caps the coupon and applies HSN GST after the line discounts', () => {
  const { items, coupon } = discountedOrder();
  const { lines, ...totals } = pricing.computeTotals(items, coupon);

  assert.deepEqual(totals, {
    subtotal: 3000, discount: 150, taxable: 2850,
    tax: 209, cgst: 104.5, sgst: 104.5, total: 3059
  });
  assert.deepEqual(
    lines.map(({ gstPercent, discount, taxable, tax }) => ({ gstPercent, discount, taxable, tax })),
    [
      { gstPercent: 5, discount: 100, taxable: 1900, tax: 95 },
      { gstPercent: 12, discount: 50, taxable: 950, tax: 114 }
    ]
  );
});

test('invoice figures include the capped discount and post-discount HSN GST', () => {
  const { rows, ...totals } = invoice.computeInvoiceFigures(discountedOrder());

  assert.deepEqual(totals, {
    subtotal: 3000, discount: 150, tax: 209,
    cgst: 104.5, sgst: 104.5, total: 3059
  });
  assert.deepEqual(
    rows.map(({ hsn, gstPercent, lineTax }) => ({ hsn, gstPercent, lineTax })),
    [
      { hsn: '1006', gstPercent: 5, lineTax: 95 },
      { hsn: '0405', gstPercent: 12, lineTax: 114 }
    ]
  );
});

test('printable invoice shows the billed GST and total without a mismatch notice', () => {
  const html = invoice.render(discountedOrder());

  assert.ok(html.includes('<td class="r">5%</td><td class="r">₹95.00</td>'));
  assert.ok(html.includes('<td class="r">12%</td><td class="r">₹114.00</td>'));
  assert.ok(html.includes('CGST + SGST (Total GST)</td><td class="r">₹209.00'));
  assert.ok(html.includes('Invoice Total</td><td class="r">₹3059.00'));
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice fallback sums the same rounded line GST as checkout', () => {
  const items = [
    { name: 'Item A', price: 0.03, qty: 1 },
    { name: 'Item B', price: 0.03, qty: 1 }
  ];
  const billed = pricing.computeTotals(items);
  const printed = invoice.computeInvoiceFigures({ items });

  assert.equal(billed.tax, 0.02);
  assert.equal(billed.total, 0.08);
  assert.deepEqual(printed.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.equal(printed.tax, 0.02);
  assert.equal(printed.cgst, 0.01);
  assert.equal(printed.sgst, 0.01);
  assert.equal(printed.total, 0.08);
});

test('reconciliation reports a match for the corrected invoice and skips cancelled orders', () => {
  const order = discountedOrder();
  const result = reports.getGstReconciliation({
    orders: [order, { ...order, id: 2, status: 'cancelled' }]
  });

  assert.equal(result.totalChecked, 1);
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.totalDelta, 0);
  const [row] = result.rows;
  assert.equal(row.orderId, 1);
  assert.deepEqual(
    [row.ledgerDiscount, row.ledgerTax, row.ledgerTotal],
    [150, 209, 3059]
  );
  assert.deepEqual([row.invoiceDiscount, row.invoiceTax, row.invoiceTotal], [150, 209, 3059]);
  assert.equal(row.delta, 0);
  assert.equal(row.matched, true);
});

test('invoice preserves recorded figures when they differ from a fresh calculation', () => {
  const order = {
    id: 3,
    items: [{ name: 'Item', price: 100, qty: 1 }],
    subtotal: 100,
    discount: 0,
    tax: 5,
    total: 105
  };
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.total, 105);
  assert.equal(figures.tax, 5);
  assert.equal(figures.cgst, 2.5);
  assert.equal(figures.sgst, 2.5);
});

test('invoice matches the billed total and GST breakdown for a discounted mixed-HSN order', () => {
  const order = discountedOrder();
  const { rows, ...totals } = invoice.computeInvoiceFigures(order);

  assert.equal(totals.total, order.total);
  assert.equal(totals.discount, order.discount);
  assert.equal(totals.tax, order.tax);
  assert.equal(totals.cgst, 104.5);
  assert.equal(totals.sgst, 104.5);
  assert.deepEqual(
    rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]),
    [[5, 95], [12, 114]]
  );
});
