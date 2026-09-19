<template>
	<div>{{ widget.id }}</div>
</template>
<script setup lang="ts">
import type { WidgetShape } from './types'

const widget: WidgetShape = { id: 'w', scale: 'oops' }
</script>
