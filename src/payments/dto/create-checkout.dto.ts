import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": the ENTIRE client input
 * to `POST /payments/checkout` — a plan identifier and nothing else. There
 * is deliberately no amount, currency, duration, or order-id field: every
 * one of those is resolved server-side from the `PAYMENT_PLANS` catalog
 * (`payment-plan.constants.ts`), so a tampered client cannot influence what
 * is charged or granted. Membership in the catalog is checked by
 * `PaymentsService` (a clean `PAYMENT_PLAN_NOT_FOUND` 404) rather than an
 * `@IsIn` here, keeping "which plans exist" a domain answer instead of a
 * validation-pipe string.
 */
export class CreateCheckoutDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  planId!: string;
}
