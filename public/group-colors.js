// Shared between index.html (avatars + roster "group" line) and
// settings.html (the roster table's group chip) so a child's group always
// reads as the same color everywhere -- one place to edit, not two.
// Deliberately thematic where it's easy (bees=gold, ladybirds=red,
// turtles=green) rather than picked at random.
window.GROUP_COLORS = {
  'Baby Monkeys': { solid: '#E8A33D', tint: '#FCEDD3', text: '#8A5A16' },
  'Busy Bees': { solid: '#D9A400', tint: '#FBF0C4', text: '#7A5E00' },
  'Turtles': { solid: '#4CAE3B', tint: '#DEF3D8', text: '#2E7A22' },
  'Butterflies': { solid: '#E15FA0', tint: '#FBE1EF', text: '#A23A73' },
  'Dragon Flies': { solid: '#2FA7C7', tint: '#DBF1F7', text: '#166E88' },
  'Owls': { solid: '#7B57B0', tint: '#EBE2F5', text: '#54397D' },
  'Ladybirds': { solid: '#DD4B3E', tint: '#FBDFDC', text: '#A32E23' }
};
window.GROUP_COLOR_FALLBACK = { solid: '#8B9285', tint: '#EDEFE9', text: '#5B6355' };
