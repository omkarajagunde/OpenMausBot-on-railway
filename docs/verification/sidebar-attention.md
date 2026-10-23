# Sidebar attention popover geometry

The Active Threads menu in the sidebar header is anchored `right-0` inside
the header's icon group, which sits 16px (`px-4`) inside the sidebar's right
edge, so the menu's width decides whether it fits. The compact sidebar is
272px wide: a static 288px (`w-72`) menu spilled 32px past the window's left
edge, where the OS clipped it — the reported bug showed the title row as
"ive Threads", because its 14px of padding left the leading text inside the
clipped zone while the thread rows below survived on their wider inset.

The icons density had a different anchoring failure: its icon cluster
stacks vertically, so the same cluster-anchored popover opened below the
"+" button that ends the column instead of below the Active Threads
button. The button and its popover are now wrapped in a container that is
`relative` in icons and `contents` (invisible to layout) in the expanded
densities, so the popover anchors to the attention button itself:
`left-0` on the button's left edge and `top-full` plus `mt-1` directly
below it.

For the interactive sidebar checks that need a human eye, see the
[sidebar fixture](sidebar.md).
