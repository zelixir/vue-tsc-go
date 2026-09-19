<script setup lang="ts">
const count: number = 1
// TS2322: string is not assignable to number
const bad: number = 'oops'

interface Props {
	title: string
	requiredNum: number
}
defineProps<Props>()

const doubled = count * 2
</script>

<template>
	<div>{{ title }} {{ doubled }}</div>
	<!-- vueCompilerError check happens in script -->
	<span>{{ missingVar }}</span>
</template>
