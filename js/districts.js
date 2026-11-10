/* Rwanda's 30 districts, used as suggestions in forms (people can still type any district). */
const RW_DISTRICTS = [
  'Gasabo', 'Kicukiro', 'Nyarugenge',
  'Bugesera', 'Gatsibo', 'Kayonza', 'Kirehe', 'Ngoma', 'Nyagatare', 'Rwamagana',
  'Burera', 'Gakenke', 'Gicumbi', 'Musanze', 'Rulindo',
  'Gisagara', 'Huye', 'Kamonyi', 'Muhanga', 'Nyamagabe', 'Nyanza', 'Nyaruguru', 'Ruhango',
  'Karongi', 'Ngororero', 'Nyabihu', 'Nyamasheke', 'Rubavu', 'Rusizi', 'Rutsiro',
];
function fillDistricts(listId) {
  const dl = document.getElementById(listId || 'districts');
  if (!dl || dl.childElementCount) return;
  RW_DISTRICTS.forEach((d) => { const o = document.createElement('option'); o.value = d; dl.appendChild(o); });
}
