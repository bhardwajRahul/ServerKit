// Dynamic geometry and runtime colors belong in React; fixed presentation
// belongs in SCSS. Report once per style prop, including conditional objects.
const isStaticValue = (node) => {
    if (!node) return false;
    if (node.type === 'Literal') return true;
    if (node.type === 'TemplateLiteral') return node.expressions.every(isStaticValue);
    if (node.type === 'UnaryExpression') return isStaticValue(node.argument);
    if (node.type === 'ConditionalExpression') {
        return isStaticValue(node.consequent) && isStaticValue(node.alternate);
    }
    return false;
};

function staticProperties(node, names = new Set()) {
    if (!node) return names;
    if (node.type === 'ObjectExpression') {
        for (const property of node.properties) {
            if (property.type === 'Property' && isStaticValue(property.value)) {
                names.add(property.key.name || String(property.key.value));
            }
        }
    } else if (node.type === 'ConditionalExpression') {
        staticProperties(node.consequent, names);
        staticProperties(node.alternate, names);
    } else if (node.type === 'LogicalExpression') {
        staticProperties(node.left, names);
        staticProperties(node.right, names);
    }
    return names;
}

export default {
    meta: {
        type: 'suggestion',
        schema: [],
        messages: { static: 'Move fixed inline presentation ({{properties}}) to SCSS; keep only computed values in style.' },
    },
    create(context) {
        return {
            'JSXAttribute[name.name="style"]'(node) {
                const names = staticProperties(node.value?.expression);
                if (node.value?.type === 'Literal') names.add('style');
                if (names.size) context.report({ node, messageId: 'static', data: { properties: [...names].join(', ') } });
            },
        };
    },
};
