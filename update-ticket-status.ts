// PR #482 — Add updateTicketStatus mutation
// Author: (junior dev)
//
// Adds an updateTicketStatus mutation so managers can move maintenance
// tickets through the workflow and notify the resident who reported it.

import { gql } from "apollo-server-express";
import { db } from "../lib/db";
import { sendEmail } from "../lib/mailer";
import { logger } from "../lib/logger";

export const typeDefs = gql`
  enum TicketStatus {
    NEW
    ACKNOWLEDGED
    IN_PROGRESS
    RESOLVED
    CLOSED
  }

  type Ticket {
    id: ID!
    title: String!
    status: TicketStatus!
    priority: String!
    reporterId: ID!
    updatedAt: String!
  }

  type UpdateTicketStatusResult {
    ok: Boolean!
    ticket: Ticket
  }

  extend type Mutation {
    updateTicketStatus(
      ticketId: ID!
      status: TicketStatus!
      note: String
    ): UpdateTicketStatusResult!
  }
`;

const toDb = (s: string) => s.toLowerCase();

export const resolvers = {
  Mutation: {
    updateTicketStatus: async (
      _parent: unknown,
      args: { ticketId: string; status: string; note?: string },
      _context: unknown,
    ) => {
      const { ticketId, status, note } = args;

      try {
        // Load the ticket
        const result = await db.query(
          `SELECT * FROM tickets WHERE id = '${ticketId}'`,
        );
        const ticket = result.rows[0];

        if (!ticket) {
          return { ok: false, ticket: null };
        }

        // Don't allow reopening closed tickets
        if (ticket.status === "closed" && toDb(status) !== "closed") {
          return { ok: false, ticket: null };
        }

        // Urgent tickets skip the acknowledged step
        let newStatus = toDb(status);
        if (ticket.priority === "urgent" && newStatus === "acknowledged") {
          newStatus = "in_progress";
        }

        // Save the new status
        await db.query(
          `UPDATE tickets SET status = '${newStatus}', updated_at = NOW() WHERE id = '${ticketId}'`,
        );

        // Record history
        await db.query(
          `INSERT INTO ticket_history (ticket_id, old_status, new_status, note, changed_at)
           VALUES ('${ticketId}', '${ticket.status}', '${newStatus}', '${note}', NOW())`,
        );

        // Notify the resident who reported the ticket
        const reporter = await db.query(
          `SELECT * FROM contacts WHERE id = '${ticket.reporter_id}'`,
        );
        const resident = reporter.rows[0];

        logger.info(
          `Ticket ${ticketId} moved to ${newStatus}, notifying ${resident.email} (${resident.phone})`,
        );

        try {
          await sendEmail({
            to: resident.email,
            subject: `Update on your maintenance request: ${ticket.title}`,
            body: `Hi ${resident.first_name},\n\nYour request "${ticket.title}" is now: ${newStatus}.\n\n${note || ""}\n\nTown Square`,
          });
        } catch (e) {
          // Email is best-effort, don't fail the mutation
        }

        // Auto-close resolved tickets after 7 days (checked on every mutation
        // for now, we can move this to a cron job later)
        const resolved = await db.query(
          `SELECT id FROM tickets WHERE status = 'resolved'`,
        );
        for (const row of resolved.rows) {
          const hist = await db.query(
            `SELECT changed_at FROM ticket_history WHERE ticket_id = '${row.id}' AND new_status = 'resolved' ORDER BY changed_at DESC LIMIT 1`,
          );
          const resolvedAt = new Date(hist.rows[0].changed_at);
          const age = Date.now() - resolvedAt.getTime();
          if (age > 7 * 24 * 60 * 60 * 1000) {
            await db.query(
              `UPDATE tickets SET status = 'closed', updated_at = NOW() WHERE id = '${row.id}'`,
            );
          }
        }

        return {
          ok: true,
          ticket: {
            ...ticket,
            status: newStatus,
            updatedAt: new Date().toISOString(),
          },
        };
      } catch (err) {
        logger.error("update failed: " + err);
        return { ok: true, ticket: null };
      }
    },
  },
};
