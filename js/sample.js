/* Made-up claims, only for showing what the dashboard looks like before real ones arrive. The names are invented, nothing here is real,
   and every row shows a "Sample" tag. They never leave this page and are never sent anywhere. */
(function (root) {
  'use strict';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const pad = (n) => String(n).padStart(2, '0');
  const r2 = (n) => Math.round(n * 100) / 100;

  function monthBack(back) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back);
    return { key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, y: d.getFullYear(), m: d.getMonth() + 1 };
  }

  // [staff, months back, status, hours ago sent, lines: [category, day, shop, receipt no, amount]]
  const SPEC = [
    ['Alex Tan', 1, 'new', 3, [['Petrol', 3, 'Kejayaan Teguh Enterprise', 'a41c9e', 60], ['Petrol', 11, 'Kejayaan Teguh Enterprise', '5cc50b', 55.64], ['Petrol', 22, 'Petronas Seksyen 13', '7d02f1', 60],
      ['Toll', 28, "Touch 'n Go", '1130739887', 27.4], ['Parking', 28, 'MBSJ Flexi Parking', '', 84.8], ['AI tools', 14, 'Eleven Labs', 'INV4417', 46.7]]],
    ['Siti Aminah', 1, 'checked', 27, [['Petrol', 6, 'Shell Subang Jaya', '88213', 60], ['Petrol', 19, 'Shell Subang Jaya', '88377', 58.2], ['Toll', 28, "Touch 'n Go", '1130739887', 41.2], ['Medical', 9, 'Klinik Putra Care', '5521', 75]]],
    ['Raj Kumar', 1, 'question', 52, [['Petrol', 2, 'Petronas Bangi', 'e90b13', 60], ['Petrol', 9, 'Petronas Bangi', 'e91c77', 60], ['Petrol', 17, 'Petronas Kajang', 'f001ab', 60], ['Petrol', 25, 'Petronas Kajang', 'f0a2cd', 60],
      ['Toll', 28, "Touch 'n Go", '1130739887', 36.07], ['Accommodation', 21, 'Pekan Auto City Budget Hotel', '257947', 94.5]]],
    ['Lim Wei Jie', 1, 'new', 5, [['Petrol', 8, 'Caltex Cheras', '30291', 60], ['Toll', 28, "Touch 'n Go", '1130739887', 22.65], ['Meals', 15, 'Restoran Sri Melaka', '1042', 38]]],
    ['Nurul Huda', 2, 'paid', 24 * 20, [['Petrol', 4, 'Shell Putrajaya', '77120', 60], ['Petrol', 14, 'Shell Putrajaya', '77288', 60], ['Petrol', 24, 'Petronas Presint 9', 'bb7e02', 55.4], ['Toll', 30, "Touch 'n Go", '1130739887', 30.1]]],
    ['Alex Tan', 2, 'paid', 24 * 21, [['Petrol', 5, 'Kejayaan Teguh Enterprise', '9ad3c0', 60], ['Petrol', 18, 'Kejayaan Teguh Enterprise', '9b01ee', 60], ['Toll', 30, "Touch 'n Go", '1130739887', 24.9], ['AI tools', 12, 'Runway', 'INV2208', 52.3]]],
    ['Raj Kumar', 2, 'paid', 24 * 20 + 6, [['Petrol', 7, 'Petronas Bangi', 'd1190a', 60], ['Petrol', 16, 'Petronas Kajang', 'd2203f', 60], ['Toll', 30, "Touch 'n Go", '1130739887', 18.5]]],
    ['Siti Aminah', 2, 'paid', 24 * 22, [['Petrol', 10, 'Shell Subang Jaya', '87001', 60], ['Toll', 30, "Touch 'n Go", '1130739887', 33.8], ['Medical', 13, 'Klinik Dr Lee', '3319', 45]]],
  ];

  function build() {
    const now = Date.now();
    return SPEC.map(([claimant, back, status, hours, rows]) => {
      const mo = monthBack(back);
      const lines = rows.map(([category, day, name, receiptNo, amount], i) => ({ no: i + 1, category, date: `${mo.key}-${pad(Math.min(day, 28))}`, name, receiptNo, amount }));
      const at = new Date(now - hours * 3600e3).toISOString();
      const history = [{ at, text: 'Received' }];
      if (status !== 'new') history.push({ at: new Date(now - hours * 3600e3 / 2).toISOString(), text: `Marked as ${({ checked: 'Checked', paid: 'Paid', question: 'Has a question' })[status]}` });
      return {
        id: `${mo.key}_${claimant.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, sample: true, claimant, month: mo.key, monthLabel: mo.label,
        total: r2(lines.reduce((a, l) => a + l.amount, 0)), lines, from: '', to: 'agnes@yutech.com.my', subject: `Claim - ${mo.label}`,
        version: 1, submittedAt: at, updatedAt: at, status, statusAt: at, history, files: [],
        note: status === 'question' ? 'The hotel receipt is only the deposit slip. Please send the full bill.' : status === 'paid' ? 'Paid by bank transfer.' : '',
      };
    });
  }

  root.WFC_SAMPLE = build;
})(window);
